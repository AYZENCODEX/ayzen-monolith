// VLT-GAP-16-B: the single repository over the `encryption_keys` table. The field-encryption and backup-envelope
// key stores each had their own byte-identical copy of these four queries (VLT-GAP-12 extracted them per caller);
// they differ only by namespace, which is already a parameter. Repositories only run queries — no business logic.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export function bootstrapFirstEncryptionKey(NAMESPACE: string, wrapDek: any, dek: any) {
  return db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, 1, ${wrapDek(dek)}, TRUE)
    ON CONFLICT (namespace, version) DO NOTHING
  `);
}

export function loadEncryptionKeys(NAMESPACE: string) {
  return db.execute(
    sql`SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = ${NAMESPACE} ORDER BY version ASC`
  );
}

export function deactivateEncryptionKeys(NAMESPACE: string) {
  return db.execute(sql`UPDATE encryption_keys SET active = FALSE WHERE namespace = ${NAMESPACE}`);
}

export function insertRotatedEncryptionKey(NAMESPACE: string, newVersion: number, wrapDek: any, dek: any) {
  return db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, ${newVersion}, ${wrapDek(dek)}, TRUE)
  `);
}
