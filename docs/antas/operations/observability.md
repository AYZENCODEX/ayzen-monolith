# Observability and SRE

Each service should expose latency, traffic, errors, and saturation. Critical
domains additionally expose finance reconciliation lag, vault decrypt and
rotation failures, workflow queue depth and stuck runs, and dead-letter depth.

Correlation identifiers must survive request, trace, event, and workflow
boundaries. Detection, alerting, diagnosis, and recovery require a real
failure drill.