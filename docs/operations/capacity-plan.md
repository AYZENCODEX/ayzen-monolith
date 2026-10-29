# Capacity plan

Capacity is modeled from observed signals, not guessed replica counts. Track
gateway p95 latency, event consumer lag, active workflow executions, Telegram
update latency, database connections/latency, and AI/resource budgets.

For each test record the sustainable limit, saturation signal, graceful
degradation behavior, cost impact, and the next scaling action. A cost review
is required before changing production capacity.