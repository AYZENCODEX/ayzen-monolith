import { decryptRow } from "../../../lib/vault-crypto";
import { LOCAL_SENSITIVE_FIELDS } from "../../domain/local-account";
import {
  selectLocalAccountValueHistory, updateLocalAccountValue, insertLocalAccountValueHistory,
} from "../../infrastructure/repositories/local-account-consumer-repository";
import type { UseCaseResult } from "./accounts";

/**
 * Per-account value tracking use-cases (VLT-GAP-02-C). Bodies moved from the
 * two `/local-accounts/:id/value*` handlers of routes/value-history.ts: same
 * validation order, same persistence order (UPDATE then history INSERT), same
 * status codes and response bodies. The route only adapts req/res.
 */
const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;

// GET /local-accounts/:id/value-history
export async function listLocalAccountValueHistory(userId: number, idParam: unknown): Promise<UseCaseResult> {
  const id = Number(idParam);
  const rows = await selectLocalAccountValueHistory(userId, id);
  return { status: 200, body: rows.rows };
}

// POST /local-accounts/:id/value
export async function saveLocalAccountValue(
  userId: number,
  idParam: unknown,
  body: { value?: unknown; buyValue?: unknown; note?: unknown; label?: unknown },
): Promise<UseCaseResult> {
  const id = Number(idParam); const value = num(body.value); const buyValue = num(body.buyValue); const note = body.note || null;
  if (!Number.isInteger(id) || !Number.isFinite(value)) return { status: 400, body: { error: "Valid value required" } };
  try {
    const result = await updateLocalAccountValue(userId, id, value, buyValue);
    if (!result.rows.length) return { status: 404, body: { error: "Account not found" } };
    const history = await insertLocalAccountValueHistory(userId, id, { label: body.label, value, buyValue, note });
    return { status: 201, body: { account: decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS), history: history.rows[0] } };
  } catch (err: any) { return { status: 500, body: { error: "Unable to save value", detail: err?.message } }; }
}
