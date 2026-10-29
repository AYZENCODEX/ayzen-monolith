# ANTAS VLT — STRICT GAP-FILLING ROADMAP
## Source-Truth / Real Extraction / Non-Bypassable Validation

### Mission

This is the gap-filling successor to the earlier VLT modularization roadmap. It assumes architecture scaffolding may exist, but certification is invalid unless source code proves that business logic actually moved from legacy implementations to the new Vault modules.

The original roadmap explicitly requires **move/extract existing logic first**, traceable OLD→NEW mapping, thin route adapters, and no completion merely because build passes. fileciteturn7file2L338-L359

### Absolute rule

`TARGET DIRECTORY EXISTS` ≠ `MODULE EXTRACTED`.

Required proof:

```text
OLD IMPLEMENTATION
→ SYMBOL INVENTORY
→ ACTUAL EXTRACTION
→ NEW OWNER
→ ALL CONSUMERS REWIRED
→ OLD FILE = THIN ADAPTER / RETIRED
→ SOURCE-GRAPH PROOF
→ BEHAVIORAL REGRESSION PROOF
→ HARD PASS
```

No rewrite. No feature redesign. No DB redesign. No crypto redesign.

# 0 — UNIVERSAL HARD VALIDATOR CONTRACT

Every sub-phase MUST have its own executable validator:

`scripts/antas/vault/gap/validate-vlt-gap-XX-Y.mjs`

## Validator MUST

1. Inspect the actual source tree.
2. Generate/consume an AST/import/call graph.
3. Enumerate old implementation symbols.
4. Enumerate destination implementation symbols.
5. Prove which symbols actually moved.
6. Prove callers migrated.
7. Prove old files no longer own extracted business logic.
8. Detect duplicate implementations.
9. Run required tests itself.
10. Check test exit codes.
11. Check build/typecheck exit codes.
12. Check forbidden imports.
13. Check migration-map entries against actual files.
14. Generate evidence itself.
15. Embed current Git commit SHA.
16. Reject evidence from another commit.
17. Reject missing evidence.
18. Reject skipped tests.
19. Reject manually asserted PASS.
20. Fail closed.

## Explicit bypass rejection

The following MUST produce FAIL:

```text
--skip
--skip-validation
--skip-tests
--force
--force-pass
--ignore-failures
--continue-on-error
VALIDATION_DISABLED=true
ANTAS_BYPASS=true
```

Unknown equivalent bypass mechanisms must also be rejected.

## Evidence

```json
{
  "phase": "VLT-GAP-XX",
  "sub_phase": "VLT-GAP-XX-Y",
  "commit_sha": "...",
  "validator_version": "...",
  "source_hashes": {},
  "commands": [],
  "exit_codes": {},
  "symbols_moved": [],
  "consumers_migrated": [],
  "old_business_symbols_remaining": [],
  "duplicate_implementations": [],
  "status": "PASS"
}
```

`status` is validator-generated only.

# GAP-00 — CERTIFICATION RESET / TRUTH BASELINE

## Multi-task

1. Record current HEAD.
2. Run all existing VLT validators.
3. Preserve their output as historical evidence only.
4. Run a repository-wide Vault source census.
5. Enumerate routes, libraries, services, jobs, events, providers and consumers.
6. Enumerate current `vault/**` implementation.
7. Compare claimed module vs actual implementation ownership.
8. Classify every module: `PROVEN`, `PARTIAL`, `SCAFFOLD_ONLY`, `UNPROVEN`.
9. Freeze final certification.
10. Create `docs/antas/vault/gap-register.md`.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-00.mjs`

## PASS

- source census is repository-derived;
- every historical claim has a source-backed status;
- final certification remains locked while any gap exists.

## FAIL

- old PASS is accepted without source proof;
- source census missing;
- result not reproducible.

## Evidence

`reports/antas/vault/gap/VLT-GAP-00/`

## Definition of Done

The project has a source-derived gap register and cannot remain falsely certified.



# GAP-01 — CORE ENTITY REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/vault.ts
routes/vault-entity-links.ts
routes/vault-snapshot.ts
routes/vault-shares.ts
```

## Business behavior that MUST become owned by the new module

```text
entity CRUD
ownership/resource builders
entity-link operations
entity calculations
```

## 01-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-01-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-01/symbol-inventory.json`

## 01-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-01-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-01/extraction-proof.json`

## 01-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-01-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-01/consumer-graph.json`

## 01-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-01-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-01/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-02 — LOCAL ACCOUNT REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/local-accounts.ts
components/local-accounts.tsx
config/fields/local-account-create.ts
config/fields/local-account-buy.ts
```

## Business behavior that MUST become owned by the new module

```text
create
update
lifecycle
ownership
purchase/buy
metadata
```

## 02-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-02-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-02/symbol-inventory.json`

## 02-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-02-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-02/extraction-proof.json`

## 02-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-02-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-02/consumer-graph.json`

## 02-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-02-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-02/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-03 — KYC REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/kyc.ts
routes/kyc-data-entities.ts
components/kyc-entries.tsx
pages/user/vault-kyc-*.tsx
```

## Business behavior that MUST become owned by the new module

```text
KYC lifecycle
KYC data
entity linkage
verification
access policy
```

## 03-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-03-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-03/symbol-inventory.json`

## 03-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-03-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-03/extraction-proof.json`

## 03-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-03-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-03/consumer-graph.json`

## 03-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-03-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-03/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-04 — GAME REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/game-entries.ts
routes/marketplace-game.ts
components/game-entries.tsx
```

## Business behavior that MUST become owned by the new module

```text
game entry
Vault entity
metadata
ownership
access
marketplace boundary
```

## 04-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-04-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-04/symbol-inventory.json`

## 04-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-04-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-04/extraction-proof.json`

## 04-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-04-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-04/consumer-graph.json`

## 04-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-04-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-04/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-05 — SECRET/CORE REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
services/vault/src/index.mjs
routes/vault.ts
lib/vault-crypto.ts
```

## Business behavior that MUST become owned by the new module

```text
secret creation
listing
reveal
versioning
tenant scope
step-up
audit
events
```

## 05-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-05-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-05/symbol-inventory.json`

## 05-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-05-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-05/extraction-proof.json`

## 05-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-05-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-05/consumer-graph.json`

## 05-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-05-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-05/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-06 — SECURITY/ACCESS REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/vault-security.ts
routes/vault-reauth.ts
lib/vault-pin-guard.ts
policy modules
```

## Business behavior that MUST become owned by the new module

```text
ownership
tenant isolation
step-up
PIN
audit
security policy
```

## 06-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-06-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-06/symbol-inventory.json`

## 06-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-06-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-06/extraction-proof.json`

## 06-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-06-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-06/consumer-graph.json`

## 06-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-06-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-06/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-07 — CRYPTO REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
lib/vault-crypto.ts
all crypto consumers
```

## Business behavior that MUST become owned by the new module

```text
encrypt/decrypt
key management
formats
legacy compatibility
rotation
```

## 07-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-07-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-07/symbol-inventory.json`

## 07-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-07-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-07/extraction-proof.json`

## 07-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-07-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-07/consumer-graph.json`

## 07-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-07-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-07/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-08 — BACKUP/RESTORE REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
lib/vault-backup-*.ts
routes/vault-backup-*.ts
backup jobs
```

## Business behavior that MUST become owned by the new module

```text
creation
envelope
key handling
delivery
cloud
audit
alerts
schedule
restore
```

## 08-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-08-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-08/symbol-inventory.json`

## 08-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-08-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-08/extraction-proof.json`

## 08-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-08-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-08/consumer-graph.json`

## 08-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-08-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-08/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-09 — SNAPSHOT/TRASH REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/vault-snapshot.ts
lib/vault-snapshot-*.ts
lib/vault-trash-*.ts
```

## Business behavior that MUST become owned by the new module

```text
snapshot
restore
trash
purge
```

## 09-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-09-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-09/symbol-inventory.json`

## 09-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-09-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-09/extraction-proof.json`

## 09-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-09-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-09/consumer-graph.json`

## 09-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-09-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-09/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-10 — SHARE/ATTACHMENT REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
routes/vault-shares.ts
routes/vault-attachments.ts
```

## Business behavior that MUST become owned by the new module

```text
share lifecycle
permissions
attachment lifecycle
storage references
```

## 10-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-10-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-10/symbol-inventory.json`

## 10-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-10-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-10/extraction-proof.json`

## 10-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-10-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-10/consumer-graph.json`

## 10-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-10-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-10/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-11 — HEALTH/OPERATIONS REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
lib/vault-health*.ts
cron files
health routes if present
```

## Business behavior that MUST become owned by the new module

```text
health service
scan
rules
cron
operational diagnostics
```

## 11-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-11-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-11/symbol-inventory.json`

## 11-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-11-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-11/extraction-proof.json`

## 11-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-11-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-11/consumer-graph.json`

## 11-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-11-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-11/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-12 — INFRASTRUCTURE REAL EXTRACTION


## Mandatory multi-task sequence

1. **READ** every source/test/config involved.
2. **INVENTORY** imports, callers, DB access, events, jobs, providers and consumers.
3. **BASELINE** current behavior before extraction.
4. **CLASSIFY** symbols as domain/application/security/infrastructure/API/adapter/legacy.
5. **MAP** every moved symbol/file OLD→NEW.
6. **EXTRACT** the existing implementation; do not create a second implementation.
7. **REWIRE** every consumer to the new owner.
8. **ADAPT** public routes only where compatibility requires them.
9. **TEST** success, failure, security, contract and concurrency cases as applicable.
10. **VALIDATE** source ownership and architecture.
11. **AUDIT DIFF** for unrelated changes.
12. **GENERATE EVIDENCE** from the validator.
13. **HARD GATE** before continuing.

## Required extraction proof

Validator MUST FAIL if:
- destination contains only interfaces/types/constants/index exports while old business logic remains;
- zero business symbols moved where extraction is required;
- old route still performs DB mutation/query for extracted behavior;
- old route still contains extracted domain/application decision trees;
- old and new modules both implement the same behavior;
- consumers still bypass the new owner;
- migration map says MIGRATED but source graph says otherwise.


## Sources

```text
all direct DB/storage/provider/event/job access under extracted Vault behavior
```

## Business behavior that MUST become owned by the new module

```text
repositories
storage adapters
providers
events
jobs
```

## 12-A — Symbol / Behavior Census

### Tasks
1. Parse every relevant source file.
2. Enumerate business functions/classes.
3. Record line ranges.
4. Record callers.
5. Record DB/provider/event/storage operations.
6. Record route handlers and branches.
7. Generate source fingerprints.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-12-A.mjs`

### PASS
Complete source-derived inventory exists.

### FAIL
Any relevant implementation is unclassified or inventory is manually authored.

### Evidence
`reports/antas/vault/gap/VLT-GAP-12/symbol-inventory.json`

## 12-B — Actual Move / Extract

### Tasks
1. Create correct destination.
2. Move/extract existing implementation.
3. Preserve behavior exactly.
4. Preserve SQL and transaction semantics.
5. Preserve crypto/encryption behavior where applicable.
6. Preserve events/audit.
7. Preserve response/error semantics.
8. Do not write a replacement implementation.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-12-B.mjs`

### PASS
Destination contains executable business implementation and moved symbols are actually used.

### FAIL
Scaffold-only destination, copied-but-unused code, rewrite, or duplicate implementation.

### Evidence
`reports/antas/vault/gap/VLT-GAP-12/extraction-proof.json`

## 12-C — Consumer Rewire

### Tasks
1. Find every old symbol consumer.
2. Rewire internal callers.
3. Rewire jobs/events/providers.
4. Keep public routes stable.
5. Make old route delegate to the new application owner.
6. Run consumer and contract tests.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-12-C.mjs`

### PASS
All required consumers use the new owner.

### FAIL
Any hidden or direct bypass remains.

### Evidence
`reports/antas/vault/gap/VLT-GAP-12/consumer-graph.json`

## 12-D — Old Source Retirement Gate

### Tasks
1. Re-scan old files.
2. Measure remaining business logic.
3. Permit only request parsing, approved auth-context construction, compatibility mapping, response mapping and compatibility exports.
4. Reject DB queries/writes.
5. Reject provider calls.
6. Reject domain calculations.
7. Reject business decision trees.
8. Reject duplicated authorization/persistence logic.
9. Prove no hidden import keeps old code authoritative.

### Validator
`scripts/antas/vault/gap/validate-vlt-gap-12-D.mjs`

### PASS
Old file is only an adapter or is retired.

### FAIL
Old implementation remains authoritative.

### Evidence

```text
reports/antas/vault/gap/VLT-GAP-12/
├── old-source-fingerprint.json
├── new-source-fingerprint.json
├── route-thinness.json
├── duplicate-implementation.json
├── behavior-regression.json
├── security-regression.json
└── gate.json
```

### Definition of Done

The new module is the actual source of truth; the old implementation is not.



# GAP-13 — ROUTE THINNESS ENFORCEMENT

## Multi-task

1. AST-scan every Vault route.
2. Detect direct DB imports.
3. Detect raw SQL.
4. Detect provider/storage access.
5. Detect business calculations.
6. Detect state mutation.
7. Detect duplicated security policy.
8. Detect route→route calls.
9. Define allowed adapter operations.
10. Generate line-level violations.
11. Add CI enforcement.
12. Intentionally introduce a violation and prove CI fails.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-13.mjs`

## PASS

Every route satisfies the adapter allowlist.

## FAIL

Any prohibited business operation remains.

## Evidence

`reports/antas/vault/gap/VLT-GAP-13/`

## Definition of Done

Routes cannot silently become business-logic containers again.

# GAP-14 — ARCHITECTURE / DEPENDENCY ENFORCEMENT

## Multi-task

1. Generate complete import graph.
2. Detect cycles.
3. Detect domain→DB/provider/frontend.
4. Detect application→route.
5. Detect API→route.
6. Detect cross-domain private imports.
7. Detect legacy implementation imports.
8. Create allowlist/denylist.
9. Add CI gate.
10. Test the gate with intentional violations.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-14.mjs`

## PASS

```text
forbidden imports = 0
new cycles = 0
domain DB imports = 0
application route imports = 0
legacy business imports = 0
```

## Evidence

`reports/antas/vault/gap/VLT-GAP-14/`

# GAP-15 — BEHAVIORAL / API / DATA / EVENT EQUIVALENCE

## Multi-task

1. Freeze representative pre-extraction fixtures.
2. Replay entity CRUD.
3. Replay account CRUD/purchase.
4. Replay KYC.
5. Replay game/marketplace.
6. Replay secret create/list/reveal.
7. Replay security negative cases.
8. Replay backup/restore.
9. Replay snapshot/restore/trash.
10. Compare status/body.
11. Compare DB ownership/version/encrypted values.
12. Compare events.
13. Compare audit records.
14. Compare side effects.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-15.mjs`

## PASS

Zero unexplained differences.

## FAIL

Any unexplained contract, data, security, event or side-effect difference.

## Evidence

`reports/antas/vault/gap/VLT-GAP-15/`

# GAP-16 — DUPLICATE / LEGACY IMPLEMENTATION ELIMINATION

## Multi-task

1. Find all `vault-*` legacy consumers.
2. Find duplicate crypto logic.
3. Find duplicate security logic.
4. Find duplicate entity/account/KYC/game logic.
5. Compare semantic fingerprints.
6. Classify old files.
7. Remove obsolete implementation only after consumer proof.
8. Re-run source scan.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-16.mjs`

## PASS

```text
duplicate business implementations = 0
unexpected legacy consumers = 0
old source-of-truth modules = 0
```

## FAIL

Any duplicate or unproven retirement.

# GAP-17 — MIGRATION MAP TRUTH GATE

The original roadmap requires a traceable migration map and one entry per moved file. fileciteturn7file5L954-L986

## Multi-task

1. Generate OLD→NEW map from source/diff.
2. Record symbols moved.
3. Record callers migrated.
4. Record status.
5. Reject MIGRATED when old behavior remains.
6. Reject RETIRED when imports remain.
7. Verify destination files.
8. Verify evidence commit SHA.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-17.mjs`

## PASS

Migration map matches repository reality.

## Evidence

`docs/antas/vault/file-migration-map.md`
and
`reports/antas/vault/gap/VLT-GAP-17/`

# GAP-18 — VALIDATOR ANTI-BYPASS / TAMPER TEST

## Multi-task

1. Build central validator runner.
2. Discover all required validators.
3. Execute every validator.
4. Reject missing validator.
5. Reject skipped test.
6. Reject stale evidence.
7. Reject fake PASS JSON.
8. Reject disabled validation environment.
9. Reject bypass CLI flags.
10. Verify final gate uses executable results only.
11. Run an intentional fake-PASS attack.
12. Confirm attack is rejected.
13. Run from clean checkout.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-18.mjs`

## PASS

- fake PASS rejected;
- stale evidence rejected;
- missing validator rejected;
- skipped test rejected;
- bypass rejected;
- failed sub-validator blocks final gate.

## FAIL

Any path exists to obtain PASS without source-level proof.

# GAP-19 — RUNTIME / CHAOS / RECOVERY

The original VLT roadmap calls for service restart, worker failure, DB/storage failure, event interruption and recovery validation. fileciteturn7file6L974-L1044

## Multi-task

1. Restart service during active request.
2. Kill worker during backup.
3. Interrupt secret write.
4. Interrupt event publication.
5. Simulate DB loss.
6. Simulate storage failure.
7. Interrupt key rotation.
8. Interrupt restore.
9. Verify retry/idempotency.
10. Verify audit continuity.
11. Verify no plaintext leakage.
12. Verify no corrupted critical state.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-19.mjs`

## PASS

No corruption, duplicate critical side effect, plaintext leak, missing critical audit event or unrecoverable state.

# GAP-20 — PERFORMANCE / QUERY REGRESSION

## Multi-task

1. Capture pre-extraction baseline.
2. Capture post-extraction baseline.
3. Test entity reads.
4. Test secret reads.
5. Test KYC reads.
6. Test account reads.
7. Test game reads.
8. Test backup.
9. Test snapshot/restore.
10. Count DB queries/request.
11. Detect N+1.
12. Measure p50/p95/p99/RPS/CPU/memory/DB connections.

## Validator

`scripts/antas/vault/gap/validate-vlt-gap-20.mjs`

## PASS

No agreed-threshold regression and no new unbounded resource growth.

# GAP-21 — FINAL SOURCE-TRUTH CERTIFICATION

## Required

1. All GAP validators PASS.
2. Full build PASS.
3. Full unit/integration/contract suite PASS.
4. Source graph PASS.
5. Route-thinness PASS.
6. Duplicate scan PASS.
7. Migration-map PASS.
8. Security PASS.
9. Crypto compatibility PASS.
10. Backup/restore PASS.
11. Snapshot/restore PASS.
12. Runtime/chaos PASS.
13. Performance PASS.
14. Fake-PASS/tamper test PASS.
15. Clean-checkout re-run PASS.

## Final validator

`scripts/antas/vault/gap/validate-vlt-gap-final.mjs`

## Final certificate

```json
{
  "status": "PASS",
  "source_of_truth_verified": true,
  "all_required_validators_executed": true,
  "extraction_proof": true,
  "route_thinness_proof": true,
  "duplicate_business_implementations": 0,
  "unexpected_legacy_consumers": 0,
  "forbidden_imports": 0,
  "behavior_regressions": 0,
  "security_regressions": 0,
  "crypto_compatibility_failures": 0,
  "backup_restore_failures": 0,
  "snapshot_restore_failures": 0,
  "runtime_failures": 0,
  "performance_regressions": 0,
  "validator_bypass_test": "PASS"
}
```

## Absolute FAIL

```text
scaffold-only module
old route remains authoritative
duplicate business implementation
consumer bypass
missing validator
validator not executed
stale evidence
fake PASS accepted
security regression
tenant isolation regression
crypto compatibility regression
backup/restore regression
snapshot/restore regression
unexplained API/event/data difference
```

## Final Definition of Done

VLT is certified only when source code proves ownership transfer, not merely that the target tree exists.

# REQUIRED SOURCE-OF-TRUTH TREE

```text
artifacts/api-server/src/vault/
├── index.ts
├── domain/
│   ├── entity/
│   ├── account/
│   ├── kyc/
│   ├── game/
│   └── secret/
├── application/
│   ├── entity/
│   ├── account/
│   ├── kyc/
│   ├── game/
│   ├── secret/
│   ├── backup/
│   ├── snapshot/
│   └── access/
├── security/
├── crypto/
├── backup/
├── snapshot/
├── health/
├── infrastructure/
│   ├── repositories/
│   ├── storage/
│   ├── providers/
│   ├── events/
│   └── jobs/
├── api/
└── contracts/
```

The original target architecture defines this source-of-truth boundary and separates API adapters from actual Vault business logic. fileciteturn7file6L1052-L1136

# REQUIRED MIGRATION STATUS

```text
SCAFFOLD_ONLY
DISCOVERED
EXTRACTING
MIGRATED
ADAPTER
VERIFIED
RETIRED
```

Only validators may promote a module to `MIGRATED`, `VERIFIED`, or `RETIRED`.

# FINAL EXECUTION LOOP

```text
READ
→ INVENTORY
→ BASELINE
→ CLASSIFY
→ MOVE/EXTRACT
→ REWIRE
→ ADAPTER
→ TEST
→ SOURCE-GRAPH VALIDATE
→ REGRESSION VALIDATE
→ EVIDENCE
→ HARD GATE
→ NEXT
```

Never:

```text
CREATE DIRECTORY
→ WRITE INDEX FILE
→ CLAIM MODULE
→ PASS
```
