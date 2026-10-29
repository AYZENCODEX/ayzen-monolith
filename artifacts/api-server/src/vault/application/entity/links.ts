import {
  INVERSE_RELATION,
  RELATION_TYPES,
  isRelationType,
  labelFor,
  type RelationType,
} from "../../domain/entity-links";
import { type VaultEntityLinkInsert, deleteVaultEntityLinksForDeleteEntityLink, executeApiForListAllEntityLinks, insertVaultEntityLinksForCreateEntityLink, selectVaultEntityLinksForCreateEntityLink, selectVaultEntityLinksForListEntityLinks, selectVaultEntriesForListEntityLinks, selectVaultEntriesForOwnsEntity, updateVaultEntityLinksForUpdateEntityLink } from "../../infrastructure/repositories/vault-entity-link-repository";

/**
 * Vault Entity Relationship Linking — application owner.
 *
 * Extracted from routes/vault-entity-links.ts (VLT-GAP-01-B). The decision
 * trees, SQL, status codes and response bodies are moved unchanged; each
 * operation returns the {status, body} the route used to write to `res`.
 */

export interface LinkResult { status: number; body: unknown }

export async function ownsEntity(id: number, userId: number): Promise<Record<string, unknown> | null> {
  const rows = await selectVaultEntriesForOwnsEntity(id, userId);
  return (rows[0] as unknown as Record<string, unknown>) ?? null;
}

// GET /vault/:id/links — all links involving this entity, either direction
export async function listEntityLinks(userId: number, idParam: string | string[]): Promise<LinkResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid entity id" } };

  const entity = await ownsEntity(id, userId);
  if (!entity) return { status: 404, body: { error: "Vault entry not found" } };

  try {
    const links = await selectVaultEntityLinksForListEntityLinks(userId, id);

    const counterpartIds = Array.from(new Set(
      links.map(l => (l.entityId === id ? l.linkedEntityId : l.entityId))
    ));
    const counterparts = counterpartIds.length
      ? await selectVaultEntriesForListEntityLinks(userId, counterpartIds)
      : [];
    const byId = new Map(counterparts.map(c => [c.id, c]));

    return {
      status: 200,
      body: links.map(l => {
        const isForward = l.entityId === id;
        const counterpartId = isForward ? l.linkedEntityId : l.entityId;
        const counterpart = byId.get(counterpartId);
        return {
          id: l.id,
          relationType: isForward ? l.relationType : INVERSE_RELATION[l.relationType as RelationType] ?? l.relationType,
          note: l.note,
          createdAt: l.createdAt,
          entity: { id, ...entity },
          linkedEntity: counterpart
            ? { id: counterpart.id, projectName: counterpart.projectName, username: counterpart.username, category: counterpart.category, status: counterpart.status, label: labelFor(counterpart) }
            : { id: counterpartId, label: "Deleted entity" },
        };
      }),
    };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch linked entities", detail: err?.message } };
  }
}

// POST /vault-entity-links — create a link between two owned entities
// body: { entityId, linkedEntityId, relationType, note? }
export async function createEntityLink(userId: number, reqBody: any): Promise<LinkResult> {
  const entityId = parseInt(reqBody.entityId, 10);
  const linkedEntityId = parseInt(reqBody.linkedEntityId, 10);
  const { relationType, note } = reqBody;

  if (isNaN(entityId) || isNaN(linkedEntityId)) return { status: 400, body: { error: "entityId and linkedEntityId are required" } };
  if (entityId === linkedEntityId) return { status: 400, body: { error: "An entity can't be linked to itself" } };
  if (!isRelationType(relationType)) return { status: 400, body: { error: `relationType must be one of: ${RELATION_TYPES.join(", ")}` } };

  const [entity, linkedEntity] = await Promise.all([ownsEntity(entityId, userId), ownsEntity(linkedEntityId, userId)]);
  if (!entity) return { status: 404, body: { error: "entityId not found or not owned by you" } };
  if (!linkedEntity) return { status: 404, body: { error: "linkedEntityId not found or not owned by you" } };

  try {
    // Duplicate check across both directions, so "A alt_of B" and re-adding
    // "B main_of A" (its inverse) don't create two rows for the same fact.
    const existing = await selectVaultEntityLinksForCreateEntityLink(userId, entityId, linkedEntityId);
    if (existing.some(l => l.relationType === relationType || l.relationType === INVERSE_RELATION[relationType])) {
      return { status: 409, body: { error: "This relationship is already linked" } };
    }

    const [row] = await insertVaultEntityLinksForCreateEntityLink(userId, entityId, linkedEntityId, relationType, note);

    return {
      status: 201,
      body: {
        id: row.id,
        relationType: row.relationType,
        note: row.note,
        createdAt: row.createdAt,
        entity: { id: entityId, ...entity },
        linkedEntity: { id: linkedEntityId, ...linkedEntity, label: labelFor(linkedEntity) },
      },
    };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to create link", detail: err?.message } };
  }
}

// PATCH /vault-entity-links/:id — edit relationType/note
export async function updateEntityLink(userId: number, idParam: string, reqBody: any): Promise<LinkResult> {
  const id = parseInt(idParam, 10);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid link id" } };
  const { relationType, note } = reqBody;
  if (relationType !== undefined && !isRelationType(relationType)) return { status: 400, body: { error: `relationType must be one of: ${RELATION_TYPES.join(", ")}` } };

  const updates: Partial<VaultEntityLinkInsert> = {};
  if (relationType !== undefined) updates.relationType = relationType;
  if (note !== undefined) updates.note = note ? String(note).trim() || null : null;

  try {
    const [row] = await updateVaultEntityLinksForUpdateEntityLink(updates, id, userId);
    if (!row) return { status: 404, body: { error: "Link not found" } };
    return { status: 200, body: { id: row.id, relationType: row.relationType, note: row.note, createdAt: row.createdAt } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to update link", detail: err?.message } };
  }
}

// DELETE /vault-entity-links/:id — remove a link
export async function deleteEntityLink(userId: number, idParam: string): Promise<LinkResult> {
  const id = parseInt(idParam, 10);
  if (isNaN(id)) return { status: 400, body: { error: "Invalid link id" } };
  try {
    const result = await deleteVaultEntityLinksForDeleteEntityLink(id, userId);
    if (!result.length) return { status: 404, body: { error: "Link not found" } };
    return { status: 200, body: { success: true } };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to delete link", detail: err?.message } };
  }
}

// GET /vault/links/all — every link across all of the user's entities.
// Enriched rows (entity names + categories on both sides), no N+1.
export async function listAllEntityLinks(userId: number): Promise<LinkResult> {
  try {
    const result = await executeApiForListAllEntityLinks(userId);
    return { status: 200, body: result.rows };
  } catch (err: any) {
    return { status: 500, body: { error: "Failed to fetch links", detail: err?.message } };
  }
}
