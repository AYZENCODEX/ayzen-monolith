---
name: Vault migration-map generation
description: Preserve the generated Vault owner map and distinguish current proof from historical certification failures.
---

The GAP-17 generator owns the per-file migration-map inventory. Certification commands must regenerate that inventory and the GAP-00 source register from the canonical map logic rather than replacing them with a static template. Keep historical failures visible; a current proof may supersede them only when it is independently bound to the code and reports the route/equivalence coverage it proves.

**Why:** A certification run once replaced the detailed migration map with a short template, erasing useful owner/origin evidence. Old GAP-04 checks also failed on frozen audits after later code changes, so treating their status as current either blocks valid code or tempts someone to flip the old report.

**How to apply:** When changing Vault certification, update the generator and validators, regenerate the map/register, and run the map self-test. Do not hand-edit generated rows or mark historical evidence PASS to clear a current gate.
