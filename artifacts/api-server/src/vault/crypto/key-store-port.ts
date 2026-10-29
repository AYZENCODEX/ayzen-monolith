/**
 * VLT-GAP-14-B: persistence port for the Vault DEK chains.
 *
 * crypto/ owns the key lifecycle and envelope formats but must not import
 * infrastructure. The `encryption_keys` queries therefore sit behind this port:
 * crypto/field-encryption.ts and crypto/backup-envelope.ts call the registered
 * store; infrastructure/crypto-key-stores.ts registers the repository-backed
 * implementations (imported by the composition root, src/index.ts).
 *
 * The crypto algorithms, key formats, namespaces and SQL are unchanged — only
 * the direction of the dependency is.
 */
export interface KeyStorePort {
  /** INSERT version 1 (active) wrapped by `wrapDek`, ON CONFLICT DO NOTHING. */
  bootstrapFirstKey(namespace: string, wrapDek: any, dek: any): PromiseLike<unknown>;
  /** SELECT version, wrapped_dek, active ... ORDER BY version ASC. */
  loadKeys(namespace: string): PromiseLike<any>;
  /** UPDATE ... SET active = FALSE for the namespace. */
  deactivateKeys(namespace: string): PromiseLike<unknown>;
  /** INSERT the new active version. `dek` is optional: the field-key store generates its own random DEK, as before. */
  insertRotatedKey(namespace: string, newVersion: number, wrapDek: any, dek?: any): PromiseLike<unknown>;
}

function createKeyStoreSlot(label: string) {
  let store: KeyStorePort | null = null;
  return {
    register(next: KeyStorePort): void {
      store = next;
    },
    get(): KeyStorePort {
      if (!store) {
        throw new Error(
          `Vault ${label} key store is not registered — import vault/infrastructure/crypto-key-stores at the process entry point`,
        );
      }
      return store;
    },
  };
}

const fieldSlot = createKeyStoreSlot("field-encryption");
const backupSlot = createKeyStoreSlot("backup-envelope");

export const registerFieldKeyStore = fieldSlot.register;
export const getFieldKeyStore = fieldSlot.get;
export const registerBackupEnvelopeKeyStore = backupSlot.register;
export const getBackupEnvelopeKeyStore = backupSlot.get;
