# Performance baseline

Performance certification is measured in staging with synthetic data. Record
the release identifier, workload shape, concurrency, duration, p50/p95/p99
latency, throughput, error rate, queue lag, database latency, and resource
usage. Thresholds come from `config/slo/gates.json`; do not invent replica
counts or production traffic volumes.

Required workloads are gateway HTTP, event throughput, workflow concurrency,
Telegram bursts, and database saturation as listed in
`infrastructure/platform/capacity-plan.json`.