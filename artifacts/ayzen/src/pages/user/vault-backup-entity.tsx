/**
 * vault-backup-entity.tsx
 * ─────────────────────────────────────────────
 * Per-account backup code detail — /vault/backup/:category/:id.
 * Mirrors vault-2fa-entity.tsx's category-dispatch shape, but for backup
 * codes: Entity reads the vault entry's backupCodes array; Local splits its
 * single free-text backup_codes column into individual codes; KYC surfaces
 * its three distinct backup fields (Account / Email / Recovery); Game
 * surfaces its one email_backup_code.
 */
import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { Shield, Smartphone, ShieldCheck, Gamepad2, Copy, Check } from "lucide-react";
import { splitCodes } from "@/pages/user/vault-backup";
import { useModuleAwareNavigate } from "@/components/module-link";

type Category = "kyc" | "local" | "entity" | "game";

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck },
  local:  { label: "Local",  icon: Smartphone },
  entity: { label: "Entity", icon: Shield },
  game:   { label: "Game",   icon: Gamepad2 },
};

interface CodeGroup { id: string; label: string; codes: string[]; }

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch { /* clipboard unavailable */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="btn sm"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {label && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}

function CodeGroupCard({ group }: { group: CodeGroup }) {
  return (
    <div className="card">
      <div className="tool">
        <span className="mono" style={{ flex: 1, fontSize: 11, color: "var(--mu)", letterSpacing: ".08em", textTransform: "uppercase" }}>{group.label}</span>
        {group.codes.length > 1 && <CopyButton value={group.codes.join("\n")} label="Copy all" />}
      </div>
      {group.codes.map((code, i) => (
        <div key={i} className="row" style={{ padding: "12px 18px" }}>
          <div className="g"><span className="mono" style={{ color: "var(--tx)", overflowWrap: "anywhere" }}>{code}</span></div>
          <CopyButton value={code} label="Copy" />
        </div>
      ))}
    </div>
  );
}

export default function VaultBackupEntity() {
  const params = useParams<{ category: string; id: string }>();
  const navigate = useModuleAwareNavigate();
  const category = (params.category as Category) ?? "entity";
  const id = Number(params.id);
  const meta = CATEGORY_META[category] ?? CATEGORY_META.entity;

  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [raw, setRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(category !== "entity");

  useEffect(() => {
    if (category === "entity") return;
    const endpoint = category === "kyc" ? "/kyc-entries" : category === "game" ? "/game-entries" : "/local-accounts";
    setLoading(true);
    customFetch<any>(endpoint).then(d => setRaw(Array.isArray(d) ? d : (d?.accounts ?? [])))
      .catch(() => setRaw([])).finally(() => setLoading(false));
  }, [category]);

  const { name, groups }: { name: string; groups: CodeGroup[] } = useMemo(() => {
    if (category === "entity") {
      const e = ((vaultData as any[]) ?? []).find(x => x.id === id);
      if (!e) return { name: "", groups: [] };
      const codes: string[] = Array.isArray(e.backupCodes) ? e.backupCodes : [];
      return { name: e.projectName || `Entity #${e.id}`, groups: codes.length ? [{ id: "backup", label: "Backup Codes", codes }] : [] };
    }
    if (category === "local") {
      const a = raw.find(x => x.id === id);
      if (!a) return { name: "", groups: [] };
      const codes = splitCodes(a.backup_codes);
      return { name: a.label ?? a.username ?? a.email ?? `Account #${a.id}`, groups: codes.length ? [{ id: "backup", label: "Backup Codes", codes }] : [] };
    }
    if (category === "kyc") {
      const e = raw.find(x => x.id === id);
      if (!e) return { name: "", groups: [] };
      const groups: CodeGroup[] = [];
      if (e.account_backup_code)  groups.push({ id: "account",  label: "Account Backup",  codes: [e.account_backup_code] });
      if (e.email_backup_code)    groups.push({ id: "email",    label: "Email Backup",    codes: [e.email_backup_code] });
      if (e.recovery_backup_code) groups.push({ id: "recovery", label: "Recovery Backup", codes: [e.recovery_backup_code] });
      return { name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, groups };
    }
    // game — single email_backup_code field
    const e = raw.find(x => x.id === id);
    if (!e) return { name: "", groups: [] };
    const groups: CodeGroup[] = e.email_backup_code ? [{ id: "email", label: "Email Backup", codes: [e.email_backup_code] }] : [];
    return { name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, groups };
  }, [category, id, vaultData, raw]);

  const isLoading = category === "entity" ? vaultLoading : loading;

  return (
    <div className="stack t-brass page-enter">
      <button type="button" className="back" onClick={() => navigate(`/vault/backup/${category}`)}>‹ Backup codes</button>
      <div className="ph">
        <div>
          <div className="eb">Backup · {meta.label}</div>
          <h1>{name || "…"}</h1>
        </div>
      </div>

      {isLoading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : groups.length === 0 ? (
        <div className="card"><div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <b style={{ fontWeight: 500 }}>No backup codes found for this account</b>
        </div></div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {groups.map(group => <CodeGroupCard key={group.id} group={group} />)}
        </div>
      )}
    </div>
  );
}
