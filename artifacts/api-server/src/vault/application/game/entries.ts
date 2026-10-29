import { encryptField, decryptRow, decryptRows } from "../../crypto/field-encryption";
import { chargeCredits } from "../../../services/credit-meter";
import { GAME_SENSITIVE_FIELDS } from "../../domain/game";
import {
  selectGameEntries, insertGameEntry, findGameEntryById, updateGameEntry, deleteGameEntry,
} from "../../infrastructure/repositories/game-repository";
import { vaultDbError as dbError, type VaultOperationResult as UseCaseResult } from "../use-case-result";
export { vaultDbError as dbError } from "../use-case-result";
export type { VaultOperationResult as UseCaseResult } from "../use-case-result";

/**
 * Game entry (Vault entity) use-cases. Bodies extracted from the handlers of
 * routes/game-entries.ts (VLT-GAP-04-B): same validation order, same
 * persistence calls in the same order, same encryption points, same status
 * codes and response bodies. A use-case never touches req/res — it returns
 * `{ status, body }` and the route adapter sends it.
 */

// Mirrors the destructuring defaults the old handler applied (`x = default` only fires on undefined).
const d = (v: unknown, dflt: unknown): any => (v === undefined ? dflt : v);

// ─── GET /game-entries — list user's game entities ───────────────────────────
export async function listGameEntries(userId: number, q: { category?: unknown }): Promise<UseCaseResult> {
  const category = (q.category as string) || null;
  try {
    const result = await selectGameEntries(userId, category);
    return { status: 200, body: decryptRows(result.rows as any[], GAME_SENSITIVE_FIELDS) };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── POST /game-entries — create game entity ─────────────────────────────────
export async function createGameEntry(userId: number, body: unknown): Promise<UseCaseResult> {
  // Destructured up front, outside the try — same as the old handler (a missing body threw before any DB work).
  const b = body as any;
  const category = d(b.category, "Other");
  const username = d(b.username, null);
  const accountPassword = d(b.accountPassword, null);
  const notes = d(b.notes, null);
  const email = d(b.email, null);
  const emailPassword = d(b.emailPassword, null);
  const email2fa = d(b.email2fa, null);
  const emailBackupCode = d(b.emailBackupCode, null);
  const rank = d(b.rank, null);
  const level = d(b.level, null);
  const accountAge = d(b.accountAge, null);
  const tags = d(b.tags, []);

  if (!category) return { status: 400, body: { error: "Category required" } };

  try {
    const result = await insertGameEntry(userId, {
      category,
      username,
      accountPassword: encryptField(accountPassword),
      notes,
      email,
      emailPassword: encryptField(emailPassword),
      email2fa: encryptField(email2fa),
      emailBackupCode: encryptField(emailBackupCode),
      rank,
      level,
      accountAge,
      tags,
    });
    return { status: 201, body: decryptRow(result.rows[0] as any, GAME_SENSITIVE_FIELDS) };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── GET /game-entries/:id — fetch single game entity (credit-metered view) ──
export async function getGameEntry(userId: number, idParam: unknown): Promise<UseCaseResult> {
  const id = parseInt(idParam as string);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid ID" } };
  try {
    const result = await findGameEntryById(id, userId);
    if (!result.rows.length) return { status: 404, body: { error: "Not found" } };
    // Charge-on-success: only after the row was actually found — a 404 above
    // never touches the ledger. Mirrors vault.ts's GET /vault/:id pattern.
    const charge = await chargeCredits(userId, "sylo.game_entry_view");
    return {
      status: 200,
      body: {
        ...decryptRow(result.rows[0] as any, GAME_SENSITIVE_FIELDS),
        _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null,
      },
    };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── PUT /game-entries/:id — update game entity ──────────────────────────────
export async function editGameEntry(userId: number, idParam: unknown, body: unknown): Promise<UseCaseResult> {
  const id = parseInt(idParam as string);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid ID" } };

  const {
    category, username, accountPassword, notes,
    email, emailPassword, email2fa, emailBackupCode,
    rank, level, accountAge, tags,
  } = body as any;

  try {
    const result = await updateGameEntry(id, userId, {
      category,
      username,
      accountPassword: encryptField(accountPassword),
      notes,
      email,
      emailPassword: encryptField(emailPassword),
      email2fa: encryptField(email2fa),
      emailBackupCode: encryptField(emailBackupCode),
      rank,
      level,
      accountAge,
      tags,
    });
    if (!result.rows.length) return { status: 404, body: { error: "Not found or forbidden" } };
    return { status: 200, body: decryptRow(result.rows[0] as any, GAME_SENSITIVE_FIELDS) };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── DELETE /game-entries/:id — delete game entity ───────────────────────────
export async function removeGameEntry(userId: number, idParam: unknown): Promise<UseCaseResult> {
  const id = parseInt(idParam as string);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid ID" } };
  try {
    await deleteGameEntry(id, userId);
    return { status: 200, body: { success: true } };
  } catch (err: any) {
    return dbError(err);
  }
}
