# ANTAS evidence policy

Every phase report contains:

- `report.json` — machine-readable status and gate counts
- `commands.txt` — commands used to produce the report
- `stdout.log` and `stderr.log` — captured command output
- `metrics.json` — measured repository or runtime metrics
- `findings.json` — failures, warnings, and explicit unverified gates

Generated evidence belongs under `reports/antas/ANTAS-XX/`. Reports must not
turn documentation into a production claim. Runtime and provider checks are
listed as `UNVERIFIED` until a real run records them.