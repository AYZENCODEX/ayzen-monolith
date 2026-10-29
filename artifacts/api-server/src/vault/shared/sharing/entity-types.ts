/**
 * Public surface of the vault entity-share type map for other apps (routes/organizations.ts,
 * org-wide vault sharing). The mapping itself (entity_type -> table / sensitive fields / label)
 * stays in infrastructure; callers import it from vault/shared, never from infrastructure (VLT-GAP-14-B).
 */
export { ENTITY_TABLES, isValidType, VALID_TYPES } from "../../infrastructure/repositories/share-entity-types";
