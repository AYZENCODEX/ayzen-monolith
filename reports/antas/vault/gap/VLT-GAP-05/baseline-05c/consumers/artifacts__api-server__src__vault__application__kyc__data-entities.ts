import { encryptField, decryptRow, decryptRows } from "../../../lib/vault-crypto";
import { KYC_DATA_ENTITY_SENSITIVE_FIELDS } from "../../domain/kyc";
import { d } from "../../domain/kyc-values";
import {
  selectKycDataEntities, selectKycDataEntityOverview, insertKycDataEntity, selectKycDataEntityForUser,
  updateKycDataEntity, findKycEntryLinkedToDataEntity, findVaultEntryLinkedToDataEntity, deleteKycDataEntity,
} from "../../infrastructure/repositories/kyc-data-entity-repository";
import { dbError, type UseCaseResult } from "./entries";

/**
 * KYC data-entity use-cases (list / overview / create / read / update /
 * delete-with-link-guard). Bodies extracted from the handlers of
 * routes/kyc-data-entities.ts (VLT-GAP-03-B): same validation order, same
 * persistence calls in the same order, same encryption, same status codes and
 * response bodies. A use-case never touches req/res.
 */

// ─── GET /kyc-data-entities — list, optionally filtered by used/unused ───────
export async function listKycDataEntities(userId: number, q: { status?: unknown }): Promise<UseCaseResult> {
  const status = (q.status as string) || null; // "used" | "unused" | null (all)
  try {
    const result = await selectKycDataEntities(userId, status);
    return { status: 200, body: decryptRows(result.rows as any[], KYC_DATA_ENTITY_SENSITIVE_FIELDS) };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── GET /kyc-data-entities/overview — roll-up stats for the Overview page ───
export async function getKycDataEntityOverview(userId: number): Promise<UseCaseResult> {
  try {
    const result = await selectKycDataEntityOverview(userId);
    return { status: 200, body: result.rows[0] ?? { total: 0, used: 0, unused: 0 } };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── POST /kyc-data-entities — create a data entity ───────────────────────────
export async function createKycDataEntity(userId: number, body: unknown): Promise<UseCaseResult> {
  const b = body as any;

  try {
    const result = await insertKycDataEntity(userId, {
      nidNumber: encryptField(d(b.nidNumber, null) as any), name: d(b.name, null), fatherName: d(b.fatherName, null), birthDate: d(b.birthDate, null),
      photo1Url: d(b.photo1Url, null), photo2Url: d(b.photo2Url, null), notes: d(b.notes, null),
    });
    return { status: 201, body: { ...decryptRow(result.rows[0] as any, KYC_DATA_ENTITY_SENSITIVE_FIELDS), used: false } };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── GET /kyc-data-entities/:id — fetch single data entity ───────────────────
export async function getKycDataEntity(userId: number, idParam: unknown): Promise<UseCaseResult> {
  const id = parseInt(idParam as string);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid ID" } };
  try {
    const result = await selectKycDataEntityForUser(id, userId);
    if (!result.rows.length) return { status: 404, body: { error: "Not found" } };
    return { status: 200, body: decryptRow(result.rows[0] as any, KYC_DATA_ENTITY_SENSITIVE_FIELDS) };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── PUT /kyc-data-entities/:id — update a data entity ────────────────────────
export async function editKycDataEntity(userId: number, idParam: unknown, body: unknown): Promise<UseCaseResult> {
  const id = parseInt(idParam as string);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid ID" } };

  const b = body as any;

  try {
    const result = await updateKycDataEntity(id, userId, {
      nidNumber: encryptField(b.nidNumber), name: b.name,
      fatherName: b.fatherName, birthDate: b.birthDate,
      photo1Url: b.photo1Url, photo2Url: b.photo2Url,
      notes: b.notes,
    });
    if (!result.rows.length) return { status: 404, body: { error: "Not found or forbidden" } };
    return { status: 200, body: decryptRow(result.rows[0] as any, KYC_DATA_ENTITY_SENSITIVE_FIELDS) };
  } catch (err: any) {
    return dbError(err);
  }
}

// ─── DELETE /kyc-data-entities/:id — delete a data entity ─────────────────────
// Blocked while a KYC entity OR a Vault entity is still linked — unlink (or
// delete) that entity first, same guard style as vault-entity-links deletes.
export async function removeKycDataEntity(userId: number, idParam: unknown): Promise<UseCaseResult> {
  const id = parseInt(idParam as string);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid ID" } };
  try {
    const linkedKyc = await findKycEntryLinkedToDataEntity(id);
    if (linkedKyc.rows.length) return { status: 409, body: { error: "Data entity is in use by a KYC entity — unlink it first" } };
    const linkedVault = await findVaultEntryLinkedToDataEntity(id);
    if (linkedVault.rows.length) return { status: 409, body: { error: "Data entity is in use by a Vault entity — unlink it first" } };
    await deleteKycDataEntity(id, userId);
    return { status: 200, body: { success: true } };
  } catch (err: any) {
    return dbError(err);
  }
}
