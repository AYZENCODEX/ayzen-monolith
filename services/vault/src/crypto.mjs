// Compatibility adapter: consumers may migrate to the owned crypto boundary
// without changing the existing import path.
export { createVaultCrypto } from "./crypto/envelope.mjs";
