# SOTA Phase 1–60 certification evidence

This directory contains machine-generated repository validation evidence for the
AYZEN SOTA Phase 1–60 roadmap.

Run the repository gate from the workspace root:

```text
node scripts/validate-sota-phase-1-60.mjs
```

The generated `sota-phase-1-60.json` report records the repository result and
keeps external production gates explicit. Phases 29, 30, and 50 still require
real staging dependencies, multi-replica chaos/load/restore/rollback runs,
provider credential rotation evidence, and container provenance evidence before
they can be certified as externally complete.