# Failure drill matrix

Failure drills run in staging with synthetic data and explicit approval. The
source matrix is `config/chaos/matrix.json`.

| Edge | Drill | Expected result | Evidence |
|---|---|---|---|
| API | timeout | bounded failure, correlation retained | `reports/ziox/D5-dependency-failure.json` |
| Database | unavailable | no fabricated write, readiness fails | `reports/ziox/C5-restore.json` |
| Event bus | lag | backpressure and observable queue growth | `reports/ziox/D1-event-bus.json` |
| Worker | crash | lease recovery and no duplicate effect | `reports/ziox/D4-worker-lifecycle.json` |
| Scheduler | missed trigger | deduplicated replay after recovery | `reports/ziox/D3-scheduler.json` |
| External provider | unavailable | bounded retry and operator alert | `reports/ziox/I7-external-drill.json` |

Each drill records start/end time, release identifier, injected failure,
observed metrics, operator, outcome, and rollback decision.