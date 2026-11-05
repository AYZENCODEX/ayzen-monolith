# gitleaks baseline

`baseline.json` is the accepted-findings baseline passed to CI via `--baseline-path`.

It is intentionally **redacted** (`--redact`) and must stay that way; matching uses the
finding fingerprint, not the secret value.

Regenerate only after triage (every entry is either a false positive or an already-rotated secret):

    gitleaks git --config .gitleaks.toml --redact --report-format json \
      --report-path reports/gitleaks/baseline.json --exit-code 0 .

Never baseline a live secret: rotate it first.
