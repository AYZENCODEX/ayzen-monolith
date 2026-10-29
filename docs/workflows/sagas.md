# Workflow orchestration and sagas

Multi-service operations are modeled as durable workflows with explicit
compensation steps for partial failure. Approval, cancellation, timeout, and
retry transitions are policy-controlled and auditable.