# Shared platform runbook

1. Run `pnpm validate:shared-platform-1-30`.
2. If the gate is blocked, inspect the finding code before changing topology.
3. For event failures, inspect the consumer checkpoint and DLQ; replay requires
   an operator scope and a reason.
4. For scheduler failures, inspect the lease owner, expiry and missed-run
   policy before retrying.
5. For policy failures, preserve the decision trace and audit record; do not
   bypass the shared decision point.
6. For unhealthy dependencies, use the readiness report and gateway fallback.