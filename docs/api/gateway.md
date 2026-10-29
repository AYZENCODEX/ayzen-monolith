# API gateway

The gateway applies request IDs, trace/correlation headers, safe upstream
selection, body limits, origin policy, rate limits, timeout handling, circuit
fallback, and endpoint registry checks. It routes to extracted services only
when their configured boundary is valid.