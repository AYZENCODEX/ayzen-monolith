// Public surface of the entity feature for sibling application features (VLT-GAP-14-B).
// Other features import `../entity`, never `../entity/<file>`; add a symbol here only
// when another feature genuinely needs it.
export { formatVaultEntry } from "./representation";
export { logVaultActivity, logVaultActivityStrict } from "./activity";
