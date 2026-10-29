# Universal enforcement gate

Run `pnpm validate:enforcement` before a release. The command evaluates the
registered dependency graph, state checkpoints, data policies, resource
budgets, runtime SLOs, policy simulation posture, recovery policies, and
lifecycle constraints. It then runs the existing platform, security, STRA, and
Telegram gates.

The report is written to
`reports/certification/enforcement-certification.json`. A `CERTIFIED` report
is required for promotion. `BLOCKED` reports identify the exact engine or
external gate that failed; no gate silently falls back to a warning.

The universal gate is deterministic and does not perform automatic production
changes. Recovery actions remain operator-approved and reversible.