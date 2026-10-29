/**
 * VLT-GAP-14-B: binds the crypto key-store ports to the `encryption_keys`
 * repository. Importing this module (side effect) registers both stores; the
 * API composition root (src/index.ts) and the backup key-rotation cron import it.
 * VLT-GAP-16-B: both stores share one repository (they differ only by namespace).
 */
import crypto from "crypto";
import { registerFieldKeyStore, registerBackupEnvelopeKeyStore } from "../crypto/key-store-port";
import {
  bootstrapFirstEncryptionKey,
  deactivateEncryptionKeys,
  insertRotatedEncryptionKey,
  loadEncryptionKeys,
} from "./repositories/encryption-key-repository";

registerFieldKeyStore({
  bootstrapFirstKey: (namespace, wrapDek, dek) => bootstrapFirstEncryptionKey(namespace, wrapDek, dek),
  loadKeys: (namespace) => loadEncryptionKeys(namespace),
  deactivateKeys: (namespace) => deactivateEncryptionKeys(namespace),
  // The field store's rotation mints its DEK here (fresh 32 random bytes), exactly as the old repository did.
  insertRotatedKey: (namespace, newVersion, wrapDek) => insertRotatedEncryptionKey(namespace, newVersion, wrapDek, crypto.randomBytes(32)),
});

registerBackupEnvelopeKeyStore({
  bootstrapFirstKey: (namespace, wrapDek, dek) => bootstrapFirstEncryptionKey(namespace, wrapDek, dek),
  loadKeys: (namespace) => loadEncryptionKeys(namespace),
  deactivateKeys: (namespace) => deactivateEncryptionKeys(namespace),
  insertRotatedKey: (namespace, newVersion, wrapDek, dek) => insertRotatedEncryptionKey(namespace, newVersion, wrapDek, dek),
});
