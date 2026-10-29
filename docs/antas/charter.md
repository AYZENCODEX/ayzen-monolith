# ANTAS charter

ANTAS is the evidence and hardening layer for AYZEN. It turns existing
architecture, security, reliability, and product controls into reproducible
phase reports.

The validator distinguishes repository evidence from runtime evidence. A file
or static check can establish that a control is implemented, but it cannot
prove a provider-backed drill, staging behavior, production traffic, or a
human approval. Those claims remain `UNVERIFIED` until evidence is supplied.

## Release rule

`criticalFailures > 0` blocks certification. Phase 18 cannot report production
readiness while any P0 runtime gate is unresolved.

Run the baseline and phase validator from the repository root:

```text
pnpm antas:baseline
pnpm antas:validate
```