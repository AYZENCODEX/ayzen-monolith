/**
 * Vault import/export (migration) use cases. Moved unchanged from routes/vault-migration.ts
 * (VLT-GAP-13-B): format validation, export column list, decrypt-on-export, per-format import
 * mappers, the 2000-row cap, identity-column exclusion, field encryption, per-row error reporting,
 * activity events, status codes and response bodies are identical. The route keeps auth, the
 * body parser/limiter, the 401 guard and response mapping.
 *
 * Export is a portable, NOT encrypted dump (see Feature 13); the encrypted full-vault backup is
 * vault/application/snapshot.
 */
import { type VaultUseCaseResult } from "../use-case-result";
import { encryptField, decryptField } from "../../crypto/field-encryption";
import { parseCsvObjects, toCsv } from "../../../lib/csv";
import { logActivity } from "../../../lib/activity";
import { SENSITIVE_VAULT_FIELDS } from "../../domain/secret-fields";
import { generateSerial } from "../../domain/serial";
import { insertVaultEntriesForModule, selectVaultEntriesForModule } from "../../infrastructure/repositories/vault-migration-repository";

export type MigrationResult = VaultUseCaseResult;

// ─── Export ─────────────────────────────────────────────────────────────────

const EXPORT_COLUMNS = [
  "category", "projectName", "username", "accountPassword",
  "email", "emailPassword", "email2fa", "emailBackupCode",
  "twitterUsername", "twitterPassword",
  "discordUsername", "discordPassword",
  "telegramUsername", "telegramPassword",
  "walletAddresses", "tags", "notes", "status", "currentValue",
] as const;

function pickExportColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of EXPORT_COLUMNS) out[c] = row[c] ?? "";
  return out;
}

/** GET /vault/export?format=csv|json — portable dump of the caller's own active entries. */
export async function exportVault(userId: number, formatQuery: unknown): Promise<MigrationResult> {
  const format = String(formatQuery ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "json") {
    return { status: 400, body: { error: "Invalid format", solution: "format must be \"csv\" or \"json\"." } };
  }

  const rows = await selectVaultEntriesForModule(userId);

  const decrypted = rows.map(r => {
    const out: Record<string, unknown> = { ...r };
    for (const f of SENSITIVE_VAULT_FIELDS) out[f] = decryptField(out[f] as any);
    return out;
  });

  await logActivity(userId, "vault_exported", null, null, null, { format, count: decrypted.length });

  if (format === "json") {
    return {
      status: 200,
      headers: { "Content-Disposition": `attachment; filename="ayzen-vault-export-${Date.now()}.json"` },
      body: { exportedAt: new Date().toISOString(), count: decrypted.length, entries: decrypted.map(pickExportColumns) },
    };
  }

  const csv = toCsv(decrypted.map(pickExportColumns), [...EXPORT_COLUMNS]);
  return {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ayzen-vault-export-${Date.now()}.csv"`,
    },
    send: csv,
  };
}

// ─── Import ─────────────────────────────────────────────────────────────────

type ImportFormat = "ayzen_csv" | "ayzen_json" | "1password" | "bitwarden" | "lastpass";
const IMPORT_FORMATS: ImportFormat[] = ["ayzen_csv", "ayzen_json", "1password", "bitwarden", "lastpass"];

type PartialEntry = Record<string, unknown>;

function joinNotes(notes?: string, url?: string): string | undefined {
  const parts = [notes?.trim(), url?.trim() ? `URL: ${url.trim()}` : ""].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

// Each mapper turns one parsed row (already split into columns by header,
// see parseCsvObjects) into our internal field names. Unknown/missing
// source columns are simply left out — never fail the row just because one
// optional column wasn't present in a particular export.
const FORMAT_MAPPERS: Record<Exclude<ImportFormat, "ayzen_json">, (row: Record<string, string>) => PartialEntry> = {
  ayzen_csv: (row) => ({
    category: row.category || undefined,
    projectName: row.projectName || row.name || undefined,
    username: row.username || undefined,
    accountPassword: row.accountPassword || undefined,
    email: row.email || undefined,
    emailPassword: row.emailPassword || undefined,
    email2fa: row.email2fa || undefined,
    emailBackupCode: row.emailBackupCode || undefined,
    twitterUsername: row.twitterUsername || undefined,
    twitterPassword: row.twitterPassword || undefined,
    discordUsername: row.discordUsername || undefined,
    discordPassword: row.discordPassword || undefined,
    telegramUsername: row.telegramUsername || undefined,
    telegramPassword: row.telegramPassword || undefined,
    walletAddresses: row.walletAddresses || undefined,
    tags: row.tags || undefined,
    notes: row.notes || undefined,
    status: row.status || undefined,
    currentValue: row.currentValue ? Number(row.currentValue) || 0 : undefined,
  }),
  // 1Password "Export as CSV" (legacy Logins export): Title,Url,Username,Password,Notes
  "1password": (row) => ({
    projectName: row.Title || row.title || "Imported item",
    username: row.Username || row.username || undefined,
    accountPassword: row.Password || row.password || undefined,
    notes: joinNotes(row.Notes || row.notes, row.Url || row.url),
  }),
  // Bitwarden "Export vault" CSV: folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
  bitwarden: (row) => ({
    projectName: row.name || "Imported item",
    username: row.login_username || undefined,
    accountPassword: row.login_password || undefined,
    account2fa: row.login_totp || undefined,
    notes: joinNotes(row.notes, row.login_uri),
  }),
  // LastPass "Export" CSV: url,username,password,extra,name,grouping,fav
  lastpass: (row) => ({
    projectName: row.name || "Imported item",
    username: row.username || undefined,
    accountPassword: row.password || undefined,
    notes: joinNotes(row.extra, row.url),
  }),
};

/** POST /vault/import — Body: { format, data }. Row-level failures never abort the whole import. */
export async function importVault(userId: number, body: any): Promise<MigrationResult> {
  const { format, data } = body ?? {};
  if (typeof format !== "string" || !IMPORT_FORMATS.includes(format as ImportFormat)) {
    return { status: 400, body: { error: "Invalid format", solution: `format must be one of: ${IMPORT_FORMATS.join(", ")}` } };
  }
  if (typeof data !== "string" || !data.trim()) {
    return { status: 400, body: { error: "data is required", solution: "Provide the raw CSV or JSON export text." } };
  }

  let entries: PartialEntry[] = [];
  try {
    if (format === "ayzen_json") {
      const parsed = JSON.parse(data);
      entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    } else {
      const rows = parseCsvObjects(data);
      const mapper = FORMAT_MAPPERS[format as Exclude<ImportFormat, "ayzen_json">];
      entries = rows.map(mapper);
    }
  } catch (err: any) {
    return { status: 400, body: { error: "Could not parse import data", detail: err?.message } };
  }

  if (entries.length === 0) return { status: 200, body: { imported: 0, skipped: 0, errors: [] } };
  if (entries.length > 2000) {
    return { status: 413, body: { error: "Too many rows", solution: "Import at most 2000 entries at a time." } };
  }

  let imported = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const projectName = String(entry.projectName ?? "").trim();
    if (!projectName) { errors.push({ row: i + 1, reason: "Missing projectName/title" }); continue; }

    const values: PartialEntry = { userId, entitySerial: generateSerial(userId), projectName };
    for (const [key, value] of Object.entries(entry)) {
      if (key === "projectName" || value === undefined || value === null || value === "") continue;
      // Never let attacker-supplied import data override identity/ownership or
      // system-managed timestamp columns — mirrors the same exclusion list used
      // by the snapshot restore use case.
      if (["id", "userId", "entitySerial", "createdAt", "updatedAt", "deletedAt"].includes(key)) continue;
      values[key] = SENSITIVE_VAULT_FIELDS.has(key) ? encryptField(String(value)) : value;
    }

    try {
      await insertVaultEntriesForModule(values);
      imported++;
    } catch (err: any) {
      errors.push({ row: i + 1, reason: err?.message ?? "Insert failed" });
    }
  }

  await logActivity(userId, "vault_imported", null, null, null, { format, imported, skipped: errors.length });

  return { status: 200, body: { imported, skipped: errors.length, errors: errors.slice(0, 50) } };
}
