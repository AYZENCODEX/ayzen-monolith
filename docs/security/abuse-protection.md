# Abuse protection

Public and authenticated routes use bounded rate limits and request-size
limits. Suspicious activity is observable through correlation and security
telemetry. Queue, workflow, AI, and notification operations have explicit
backpressure or budget controls so a caller cannot exhaust shared resources.

Abuse tests run against synthetic staging data and verify bounded denial,
cooldown, audit visibility, and recovery after the limit window.