import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, vaultSnapshotsTable } from "@workspace/db";
/**
 * DB access for the Vault snapshot / trash route handlers, extracted verbatim
 * from routes/vault-snapshot.ts (VLT-GAP-09). Queries, column lists, ordering
 * and soft-delete predicates (`deleted_at IS [NOT] NULL`) are unchanged. The
 * helpers that build/store/prune snapshots keep their own inline queries in
 * vault/application/snapshot/{payload,store}.ts (moved byte-identical).
 */

/** GET /vault/snapshots — metadata only, never the blob. */
export async function listLiveSnapshotRows(userId: number) {
  return db
    .select({
      id: vaultSnapshotsTable.id,
      label: vaultSnapshotsTable.label,
      sizeBytes: vaultSnapshotsTable.sizeBytes,
      includesAttachments: vaultSnapshotsTable.includesAttachments,
      entriesCount: vaultSnapshotsTable.entriesCount,
      walletsCount: vaultSnapshotsTable.walletsCount,
      mailboxCount: vaultSnapshotsTable.mailboxCount,
      projectsCount: vaultSnapshotsTable.projectsCount,
      tasksCount: vaultSnapshotsTable.tasksCount,
      financeCount: vaultSnapshotsTable.financeCount,
      walletHubCount: vaultSnapshotsTable.walletHubCount,
      activityCount: vaultSnapshotsTable.activityCount,
      entityCoverageCount: vaultSnapshotsTable.entityCoverageCount,
      emergencyAccessCount: vaultSnapshotsTable.emergencyAccessCount,
      accountExtrasCount: vaultSnapshotsTable.accountExtrasCount,
      teamCount: vaultSnapshotsTable.teamCount,
      earningCount: vaultSnapshotsTable.earningCount,
      backupSystemCount: vaultSnapshotsTable.backupSystemCount,
      emailAccountsCount: vaultSnapshotsTable.emailAccountsCount,
      mailboxReputationCount: vaultSnapshotsTable.mailboxReputationCount,
      externalMailCount: vaultSnapshotsTable.externalMailCount,
      source: vaultSnapshotsTable.source,
      encryptionMode: vaultSnapshotsTable.encryptionMode,
      createdAt: vaultSnapshotsTable.createdAt,
    })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)))
    .orderBy(desc(vaultSnapshotsTable.createdAt));
}

/** GET /vault/snapshots/storage — sizes of the live (non-trashed) rows. */
export async function listLiveSnapshotSizes(userId: number) {
  return db
    .select({ sizeBytes: vaultSnapshotsTable.sizeBytes })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
}

/** Download: the full live row, scoped to its owner. */
export async function getLiveSnapshotRow(id: number, userId: number) {
  const [row] = await db.select().from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
  return row;
}

/** PATCH — rename (applies to live or trashed rows, as before). */
export async function renameSnapshotRow(id: number, userId: number, label: string | null) {
  const [updated] = await db.update(vaultSnapshotsTable)
    .set({ label: label || null })
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId)))
    .returning({ id: vaultSnapshotsTable.id });
  return updated;
}

/** DELETE /vault/snapshots/:id — soft-delete (sets deleted_at). */
export async function trashSnapshotRow(id: number, userId: number) {
  const [trashed] = await db.update(vaultSnapshotsTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)))
    .returning({ id: vaultSnapshotsTable.id });
  return trashed;
}

/** GET /vault/snapshots/trash — most recently trashed first. */
export async function listTrashedSnapshotRows(userId: number) {
  return db
    .select({
      id: vaultSnapshotsTable.id,
      label: vaultSnapshotsTable.label,
      sizeBytes: vaultSnapshotsTable.sizeBytes,
      entriesCount: vaultSnapshotsTable.entriesCount,
      walletsCount: vaultSnapshotsTable.walletsCount,
      source: vaultSnapshotsTable.source,
      encryptionMode: vaultSnapshotsTable.encryptionMode,
      createdAt: vaultSnapshotsTable.createdAt,
      deletedAt: vaultSnapshotsTable.deletedAt,
    })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNotNull(vaultSnapshotsTable.deletedAt)))
    .orderBy(desc(vaultSnapshotsTable.deletedAt));
}

/** POST /vault/snapshots/:id/restore — undo a soft-delete. */
export async function untrashSnapshotRow(id: number, userId: number) {
  const [restored] = await db.update(vaultSnapshotsTable)
    .set({ deletedAt: null })
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNotNull(vaultSnapshotsTable.deletedAt)))
    .returning({ id: vaultSnapshotsTable.id });
  return restored;
}

/** DELETE /vault/snapshots/trash/:id — the row must already be trashed. */
export async function getTrashedSnapshotIdRow(id: number, userId: number) {
  const [trashedRow] = await db.select({ id: vaultSnapshotsTable.id })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNotNull(vaultSnapshotsTable.deletedAt)));
  return trashedRow;
}

/** Permanent delete (the migration-072 DB trigger may refuse it). */
export async function deleteSnapshotRow(id: number, userId: number): Promise<void> {
  await db.delete(vaultSnapshotsTable).where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId)));
}

export function selectVaultSnapshotsForPruneOldSnapshots(userId: number) {
  return db
    .select({ id: vaultSnapshotsTable.id, sizeBytes: vaultSnapshotsTable.sizeBytes })
    .from(vaultSnapshotsTable)
    .where(and(eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)))
    .orderBy(desc(vaultSnapshotsTable.createdAt));
}

export function updateVaultSnapshotsForPruneOldSnapshots(id: number, userId: number) {
  return db.update(vaultSnapshotsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
}

export function insertVaultSnapshotsForStoreSnapshotRow(input: any, checksum: string) {
  return db.insert(vaultSnapshotsTable).values({
    userId: input.userId,
    label: input.label,
    blob: input.blob,
    sizeBytes: Buffer.byteLength(input.blob, "utf8"),
    includesAttachments: !!input.includeAttachments,
    entriesCount: input.entriesCount,
    walletsCount: input.walletsCount,
    mailboxCount: input.mailboxCount ?? 0,
    projectsCount: input.projectsCount ?? 0,
    tasksCount: input.tasksCount ?? 0,
    financeCount: input.financeCount ?? 0,
    walletHubCount: input.walletHubCount ?? 0,
    activityCount: input.activityCount ?? 0,
    entityCoverageCount: input.entityCoverageCount ?? 0,
    emergencyAccessCount: input.emergencyAccessCount ?? 0,
    accountExtrasCount: input.accountExtrasCount ?? 0,
    teamCount: input.teamCount ?? 0,
    earningCount: input.earningCount ?? 0,
    backupSystemCount: input.backupSystemCount ?? 0,
    emailAccountsCount: input.emailAccountsCount ?? 0,
    mailboxReputationCount: input.mailboxReputationCount ?? 0,
    externalMailCount: input.externalMailCount ?? 0,
    checksum,
    source: input.source,
    encryptionMode: input.encryptionMode,
    encryptionVersion: input.encryptionVersion ?? null,
  }).returning({ id: vaultSnapshotsTable.id });
}

export function selectVaultSnapshotsForDecryptSnapshotFromRequest(id: number, userId: number) {
  return db.select().from(vaultSnapshotsTable)
      .where(and(eq(vaultSnapshotsTable.id, id), eq(vaultSnapshotsTable.userId, userId), isNull(vaultSnapshotsTable.deletedAt)));
}

export function selectVaultSnapshotsForVaultSnapshotResource(id: number) {
  return db.select({ userId: vaultSnapshotsTable.userId })
    .from(vaultSnapshotsTable)
    .where(eq(vaultSnapshotsTable.id, id))
    .limit(1);
}
