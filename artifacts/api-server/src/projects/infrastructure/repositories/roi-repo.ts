// projects/infrastructure/repositories/roi-repo.ts
// Reads of `entity_project_roi` joined to `vault_entries` for names. Writers of entity_project_roi live
// elsewhere (routes/entities.ts, services/sync.ts) and are recorded in the boundary manifest.
import { db, entityProjectRoiTable, vaultEntriesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export function listRoiRowsForUserProject(userId: number, projectId: number) {
  return db
    .select({ roi: entityProjectRoiTable, vault: vaultEntriesTable })
    .from(entityProjectRoiTable)
    .leftJoin(vaultEntriesTable, eq(entityProjectRoiTable.vaultEntryId, vaultEntriesTable.id))
    .where(and(eq(entityProjectRoiTable.projectId, projectId), eq(entityProjectRoiTable.userId, userId)));
}
