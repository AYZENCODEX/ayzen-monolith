# ANTAS VLT — LEAN GAP-FILLING ROADMAP
## Same goal as the STRICT roadmap — real extraction, traceable OLD→NEW, no scaffold-only modules — with validators that stay proportional to the code being moved.

### Why this version exists

The STRICT roadmap (`ANTAS_VLT_GAP_FILLING_ROADMAP_STRICT.md`) is correct in what it demands, but each sub-phase shipped its **own** 150–700 line bespoke validator (sealed baselines, mutation self-tests, child-process bypass attacks, differential typecheck harnesses). For a source file of 100–500 lines, the validator ended up 2–5× the size of the thing it was validating. That inverts the effort: most of the work went into proving the proof, not doing the extraction.

This version keeps every GAP, every `Sources` list, every `Business behavior` list, and the same non-negotiable outcome (old file retired/thin, new module is the real owner, no duplicate implementation, no bypass). What changes is **how** that gets checked:

```text
STRICT: 1 bespoke validator script PER sub-phase (A/B/C/D × 12+ gaps = 40+ scripts, ~700 lines each)
LEAN:   1 generic validator script, driven by a ~20-line config PER gap (1 script, total ≈ 250 lines)
```

The generic validator is intentionally *less* thorough than STRICT's (no mutation testing, no simulated bypass attacks, no sealed-baseline cryptographic reconstruction). It catches the failure modes that actually happen during extraction — scaffold-only destinations, orphaned references, un-rewired consumers, duplicated logic, lost behavior — with grep/AST-lite checks that run in under a second. The expensive stuff (anti-tamper proofing, chaos testing, performance regression) is real work but it doesn't need to gate every single file move; it moves to a **Hardening Phase** at the end that you build once, after extraction is actually done, not 12 times along the way.

### Absolute rule (unchanged)

`TARGET DIRECTORY EXISTS` ≠ `MODULE EXTRACTED`.

```text
OLD IMPLEMENTATION → SYMBOL LIST → ACTUAL EXTRACTION → NEW OWNER
→ CONSUMERS REWIRED → OLD FILE THIN/RETIRED → LIGHT PROOF → PASS
```

No rewrite. No feature redesign. No DB redesign. No crypto redesign. This is extraction, not a rewrite — the lean validator cannot tell a careful rewrite from a careless one, so this discipline still has to come from you/the agent doing the move, not from the script.

---

# 0 — ONE GENERIC VALIDATOR, CONFIG-DRIVEN

Instead of `scripts/antas/vault/gap/validate-vlt-gap-XX-Y.mjs` per sub-phase, there is exactly one script:

```text
scripts/antas/vault/gap/validate-gap.mjs --gap 06 --stage extract
scripts/antas/vault/gap/validate-gap.mjs --gap 06 --stage rewire
scripts/antas/vault/gap/validate-gap.mjs --gap 06 --stage retire
```

It reads a small config file per gap:

```text
scripts/antas/vault/gap/config/GAP-06.json
```

### Config shape

```json
{
  "gap": "VLT-GAP-06",
  "title": "SECURITY/ACCESS",
  "old_files": [
    "artifacts/api-server/src/routes/vault-security.ts",
    "artifacts/api-server/src/routes/vault-reauth.ts",
    "artifacts/api-server/src/lib/vault-pin-guard.ts"
  ],
  "new_files": [
    "artifacts/api-server/src/vault/security/lockout.ts",
    "artifacts/api-server/src/vault/security/pin-guard.ts",
    "artifacts/api-server/src/vault/application/security/*.ts"
  ],
  "required_symbols": [
    "requireVaultPin", "setPin", "verifyPin", "setVaultPassword",
    "disableVaultPassword", "setupVaultTwoFa", "verifyVaultTwoFa"
  ],
  "forbidden_in_old": [
    "db\\.(select|insert|update|delete)\\(",
    "\\bawait\\s+db\\.",
    "bcrypt|hashPassword|verifyPassword",
    "new Map\\("
  ],
  "allowed_old_shape": "thin-adapter",
  "consumer_glob": "artifacts/api-server/src/**/*.ts"
}
```

Writing this config is the entire "census" step — it replaces `06-A`'s own validator and its hand-rolled `symbol-inventory.json`. You fill it in once by reading the old file(s); the script does the rest.

### What the generic validator actually checks (per stage)

**`--stage extract`** — does the new owner exist and hold real code?
1. Every file in `new_files` parses as valid TypeScript (AST parse, no project resolution needed).
2. Every `required_symbols` entry is found as an exported function/const across `new_files`.
3. None of `new_files` is import-only (every file must contain at least one non-import, non-type statement with a function body or executable expression) — this is the "scaffold-only" check.
4. Every relative import inside `new_files` resolves to a real file on disk.

**`--stage rewire`** — do consumers actually use the new owner, and is behavior preserved?
5. `grep` `consumer_glob` for imports of the old symbol names; after rewire, the only file still importing the old path's *named* exports should be the old file itself (re-exporting) — everything else must import from `new_files`.
6. **Literal-parity diff** (cheap, deterministic, catches almost every real regression): extract the set of HTTP status codes (`status(xxx)` / `status: xxx`), `code: "..."` error-code strings, and route path literals (`router.get/put/post("...")`) from the pre-extraction old file (via `git show <baseline-commit>:<path>`) and from the current `old_files + new_files` combined. The two sets must be equal. This is exactly the check that caught nothing wrong (and would have caught the dropped `REVEAL_TOKEN_TTL_MS` reference, or any dropped error path) in the VLT-GAP-06-B work already done on `vault-security.ts` — a two-command `diff` that takes under a second, instead of a 51-case executed differential harness.

**`--stage retire`** — is the old file actually thin or gone?
7. For each path in `old_files` that still exists: run every pattern in `forbidden_in_old` against its text; zero matches allowed.
8. Line count of each surviving old file must be under a configurable ceiling (default 200) — if it's still big, it still owns logic, config review required before claiming retire.
9. `allowed_old_shape: "thin-adapter"` → file must consist only of: imports, a router instance, route handlers whose body is `const out = await <app-fn>(...); res.status(out.status).json(out.body);` (regex-matched), and nothing else. `allowed_old_shape: "re-export"` → file must be only `export { ... } from "..."` lines (used for lib compatibility shims like the old `vault-pin-guard.ts`).

### Evidence (small, one file, not six)

```json
{
  "gap": "VLT-GAP-06",
  "stage": "retire",
  "commit_sha": "...",
  "checked_at": "...",
  "old_files": { "artifacts/.../routes/vault-security.ts": { "lines": 182, "forbidden_hits": [], "shape_ok": true } },
  "required_symbols_found": ["requireVaultPin", "setPin", "..."],
  "literal_parity": { "status_codes_equal": true, "error_codes_equal": true, "route_paths_equal": true },
  "consumer_check": { "old_named_imports_remaining": [] },
  "status": "PASS"
}
```

One file (`reports/antas/vault/gap/VLT-GAP-XX/<stage>.json`), not `old-source-fingerprint.json` + `new-source-fingerprint.json` + `route-thinness.json` + `duplicate-implementation.json` + `behavior-regression.json` + `security-regression.json` + `gate.json`.

### Still non-negotiable (kept from STRICT)

- Fail closed: missing config, missing file, or a check that can't run is a FAIL, not a skip.
- Bypass-flag rejection (`--force`, `--skip`, `VALIDATION_DISABLED=true`, etc.) stays — it's a 10-line regex check, cheap to keep.
- `status` is validator-written only; nobody hand-edits the evidence JSON and claims PASS.
- Still three real gates (extract → rewire → retire) before a GAP is called done — the lean version is cheaper per gate, not fewer gates.

### What got cut, on purpose, for now

- Sealed/frozen baseline trees with SHA-pinned "write-once" verification.
- Mutation self-tests (40+ synthetic bugs injected and confirmed caught).
- Simulated bypass attacks run as child processes.
- Full differential execution harnesses (real `node:crypto`/DB calls replayed case-by-case).
- Per-phase diff-audit against a reconstructed pre-extraction tree.

These aren't wrong to want — they belong in the **Hardening Phase** (bottom of this doc), built once, run across the whole `vault/` tree, instead of re-invented per sub-phase.

---

# GAP INDEX (same scope as STRICT, unchanged Sources/Behaviors)

Each row below is everything a GAP needs: what it reads, what must move, and what `config/GAP-XX.json` should declare. The three gates (`extract` → `rewire` → `retire`) are the same for every row; only the config differs.

| GAP | Title | Sources | Business behavior that must move |
|---|---|---|---|
| 00 | Certification reset / truth baseline | whole repo | source census → `docs/antas/vault/gap-register.md`; classify every `vault/**` module `PROVEN / PARTIAL / SCAFFOLD_ONLY / UNPROVEN` |
| 01 | Core entity | `routes/vault.ts`, `routes/vault-entity-links.ts`, `routes/vault-snapshot.ts`, `routes/vault-shares.ts` | entity CRUD, ownership/resource builders, entity-link operations, entity calculations |
| 02 | Local account | `routes/local-accounts.ts`, `components/local-accounts.tsx`, `config/fields/local-account-{create,buy}.ts` | create, update, lifecycle, ownership, purchase/buy, metadata |
| 03 | KYC | `routes/kyc.ts`, `routes/kyc-data-entities.ts`, `components/kyc-entries.tsx`, `pages/user/vault-kyc-*.tsx` | KYC lifecycle, KYC data, entity linkage, verification, access policy |
| 04 | Game | `routes/game-entries.ts`, `routes/marketplace-game.ts`, `components/game-entries.tsx` | game entry, vault entity, metadata, ownership, access, marketplace boundary |
| 05 | Secret/core | `services/vault/src/index.mjs`, `routes/vault.ts`, `lib/vault-crypto.ts` | secret creation, listing, reveal, versioning, tenant scope, step-up, audit, events |
| 06 | Security/access | `routes/vault-security.ts`, `routes/vault-reauth.ts`, `lib/vault-pin-guard.ts`, policy modules | ownership, tenant isolation, step-up, PIN, audit, security policy — **`vault-security.ts` side already extracted and verified in this repo; `vault-reauth.ts` still open** |
| 07 | Crypto | `lib/vault-crypto.ts`, all crypto consumers | encrypt/decrypt, key management, formats, legacy compatibility, rotation |
| 08 | Backup/restore | `lib/vault-backup-*.ts`, `routes/vault-backup-*.ts`, backup jobs | creation, envelope, key handling, delivery, cloud, audit, alerts, schedule, restore |
| 09 | Snapshot/trash | `routes/vault-snapshot.ts`, `lib/vault-snapshot-*.ts`, `lib/vault-trash-*.ts` | snapshot, restore, trash, purge |
| 10 | Share/attachment | `routes/vault-shares.ts`, `routes/vault-attachments.ts` | share lifecycle, permissions, attachment lifecycle, storage references |
| 11 | Health/operations | `lib/vault-health*.ts`, cron files, health routes if present | health service, scan, rules, cron, operational diagnostics |
| 12 | Infrastructure | all direct DB/storage/provider/event/job access under extracted Vault behavior | repositories, storage adapters, providers, events, jobs |
| 13 | Route-thinness enforcement | every `routes/vault*.ts` | every handler ≤ the `allowed_old_shape: thin-adapter` regex, repo-wide |
| 14 | Architecture/dependency enforcement | whole `vault/**` tree | layer rule: `api → application → domain/security → infrastructure`, never the reverse; one `forbidden_in_old`-style regex scan per layer boundary |
| 15 | Behavioral/API/data/event equivalence | whole `vault/**` tree | the literal-parity diff (status/error-code/route-path sets) run repo-wide instead of per-file |
| 16 | Duplicate/legacy elimination | whole repo | `grep`-based duplicate-function-body scan (same body hash under two exported names = duplicate) |
| 17 | Migration map truth gate | `docs/antas/vault/file-migration-map.md` | one row per moved file; `MIGRATED`/`RETIRED` claims cross-checked against the actual tree by the same generic validator in a `--stage map-check` mode |
| 21 | Final certification | all of the above | every `reports/antas/vault/gap/VLT-GAP-*/retire.json` (or `map-check.json`) says `PASS`; nothing more — see below |

GAP numbering, sources and required behaviors are identical to the STRICT roadmap; nothing in scope was dropped, only the proof mechanism.

---

# HARDENING PHASE — build once, later, across the whole tree

These are the parts worth doing properly, but not worth re-deriving per file. Do them **after** GAP-00 through GAP-17 are all green, against the whole `vault/` tree at once.

### H1 — Anti-bypass / tamper test (was GAP-18)
One script that runs every `config/GAP-*.json` through the generic validator, confirms a hand-edited `"status": "PASS"` JSON is rejected (evidence must be validator-generated — check a stored HMAC or regenerate and diff), and confirms the bypass-flag rejection still works from a clean checkout.

### H2 — Runtime / chaos / recovery (was GAP-19)
Service restart mid-request, worker kill mid-backup, DB/storage failure injection, event-interruption recovery — run against the *finished* `vault/` module, not against each sub-phase. Verify no plaintext leak, no corrupted critical state, audit continuity.

### H3 — Performance / query regression (was GAP-20)
Pre- vs post-extraction baseline on reads/writes across entity/secret/KYC/account/game, N+1 detection, p50/p95/p99. One baseline capture, one comparison run, not one per GAP.

### H4 — Promote the generic validator itself, if you want STRICT-level proof later
`validate-gap.mjs` can grow mutation self-tests and sealed baselines the same way the STRICT scripts had them — add it as a `--strict` flag that layers on top of the lean checks once you decide a given GAP needs that level of proof (e.g. the crypto owner, GAP-07, is the most plausible candidate — field-level encryption is exactly the kind of code worth the expensive differential harness). Nothing here prevents escalating; it just stops every phase from paying that cost by default.

---

# EXECUTION LOOP (lean)

```text
READ → FILL config/GAP-XX.json (old_files, new_files, required_symbols, forbidden_in_old)
     → MOVE/EXTRACT (write the new owner, make old file delegate)
     → node validate-gap.mjs --gap XX --stage extract
     → REWIRE consumers
     → node validate-gap.mjs --gap XX --stage rewire
     → shrink old file to thin-adapter / delete it
     → node validate-gap.mjs --gap XX --stage retire
     → NEXT GAP
```

Still never:

```text
CREATE DIRECTORY → WRITE INDEX FILE → CLAIM MODULE → PASS
```

The generic validator's `extract` stage (required-symbols + non-scaffold check) is exactly what blocks that shortcut — it stays, because it's the cheapest check here and the one that matters most.
