# VLT-GAP-16 A-B — duplicate / legacy elimination

## A — scanner
`node scripts/antas/vault/gap/validate-vlt-gap-16.mjs` (`pnpm validate:vault-duplicates`), config `gap-configs/vault-duplicates.json`.
- D1: scope-aware alpha-renamed body fingerprint (>=1 statement, >=60 normalised chars; template/regex literals included). Same fingerprint in two places = duplicate.
- L1/L2: legacy files (`lib/vault-*`) must be pure re-export shims, listed in `allowed_shims` with evidence, with only listed consumers.
- C1: AES/HKDF primitives outside the crypto owners. S1: security primitives outside `vault/security`, unless bound by an import from `lib/password` or in `security_primitive_allow` (reason + evidence substring + max use count).
- Allowlist entries are only honoured while their `requires` evidence exists in the repo.
- `--self-test` (`pnpm validate:vault-duplicates:self-test`): 13 planted cases (renamed duplicate, literal-change non-duplicate, legacy owner, unlisted shim, legacy consumer, inline cipher, timing-safe compare, approved import, unlisted scrypt, allowlist over cap, shim gaining a consumer, accepted shim, clean tree).
Evidence: `reports/antas/vault/gap/VLT-GAP-16/{duplicate-scan,ci-fail-proof}.json`.

## B — removed duplicates (20 groups -> 0)
- 3x `respondWith{Attachment,Migration,Snapshot}Result` -> `vault/application/use-case-result.ts` (`respondWithVaultResult`).
- 3x `deny*` responders (game/kyc/local-account) -> `vault/security/deny-responses.ts`.
- entity + local-account receipt token/url helpers -> `vault/security/receipt-token.ts`.
- `field-key-repository` + `backup-envelope-key-repository` -> `encryption-key-repository.ts`; `crypto-key-stores.ts` rewired.
- `deriveKekLegacy` x2 removed (call `deriveLegacyAesKey(raw, 32)`).
- numbered repository copies removed (bulk, update, admin, attachment, health, security, share, migration/snapshot-payload).

## Decisions / limits
- `lib/vault-pin-guard.ts` kept as a zero-consumer allowed shim: 06-D, GAP-14 and GAP-15 configs still require it.
- `lib/finance-accounting.ts` has its own `generateReceiptToken` (outside Vault scope, not touched).
- Not run here: `tsc`, unit tests (no node_modules). 06-D needs tsc.
- A regression introduced mid-way (dangling `deriveKekLegacy` call) was caught by `differential-vlt-gap-15-backup`; fixed.
