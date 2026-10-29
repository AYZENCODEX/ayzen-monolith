# AYZEN — Advanced Hybrid Monolith Architecture Roadmap
## Phased Architecture Evolution: Modular Monolith → Hybrid → Selective Microservices

### Target Architecture

AYZEN should evolve toward an **Advanced Hybrid Monolith / Selective Microservices Architecture**.

The goal is NOT to split every module into a microservice.

The target is:

```text
                         AYZEN Platform
                              │
                  ┌───────────┴───────────┐
                  │                       │
             Web / Mobile            Telegram Bots
                  │                       │
                  └───────────┬───────────┘
                              ↓
                         API Gateway
                              │
                 ┌────────────┴────────────┐
                 ↓                         ↓
          Core Modular Monolith      Extracted Services
                 │                         │
        ┌────────┼────────┐       ┌────────┼─────────┐
        ↓        ↓        ↓       ↓        ↓         ↓
     Workspace  User   Shared   Identity  WISP     RYFT
     Core       Core   Domains  Service   Mail     Finance
        │                         │        │         │
        └────────────┬────────────┴────────┴─────────┘
                     ↓
                Event Bus
                     │
          ┌──────────┼───────────┐
          ↓          ↓           ↓
        ACIE      Notification  Workflow
     Intelligence     │          │
          │            └────┬─────┘
          ↓                 ↓
              Intelligence Console
```

## Core Principles

1. **Modular first, distributed second.**
2. A module becomes a service only when there is a real operational reason.
3. Domain ownership must exist before physical extraction.
4. No shared database writes between services.
5. Events cross service boundaries; internal function calls remain inside the monolith.
6. Keep synchronous APIs for operations requiring immediate responses.
7. Use asynchronous events for notifications, analytics, intelligence, workflows and integrations.
8. Preserve backward compatibility during extraction.
9. Every extraction needs observability, tests, rollback and ownership.
10. Service count should remain intentional — target approximately 10–15 meaningful services.
11. Service != server. Multiple services can run on one machine initially.
12. Kubernetes is not required at the beginning.

---

# PHASE 0 — Architecture Baseline & Inventory

### Goal
Create an exact map of the current AYZEN architecture before changing runtime boundaries.

### Tasks
- Inventory all backend modules.
- Inventory route modules.
- Inventory engines.
- Inventory database schemas.
- Inventory migrations.
- Inventory event producers/consumers.
- Inventory scheduled jobs/workers.
- Inventory external integrations.
- Identify direct cross-domain imports.
- Identify shared utility packages.
- Identify shared database access.
- Identify modules that cannot currently be deployed independently.

### Deliverables
- Domain map
- Dependency graph
- Runtime graph
- Database ownership map
- Event-flow map
- Extraction candidate list

### Definition of Done
Every major backend domain has:
- owner
- dependencies
- data ownership
- API surface
- event surface
- extraction difficulty
- operational importance

---

# PHASE 1 — Domain Boundary Enforcement

### Goal
Turn the existing modular structure into enforceable architecture.

### Target domains

Potential boundaries:

```text
Identity
Authorization
User
Workspace
Finance / RYFT
Vault / SYLO
Mail / WISP
Notification
Workflow / SKARN
AI / ZYNTH
Communication / VERVE
Marketplace
Intelligence / ACIE
Telemetry
Search / Knowledge
```

Not every domain must become a service.

### Rules
- No random cross-domain DB queries.
- No importing another domain's private implementation.
- No direct access to another domain's repository.
- Cross-domain operations use:
  - public application APIs
  - domain events
  - shared contracts

### Deliverables
- `domain/<name>/api`
- `domain/<name>/application`
- `domain/<name>/domain`
- `domain/<name>/infrastructure`

### Definition of Done
A domain can be reasoned about independently without reading the entire repository.

---

# PHASE 2 — Internal Platform Contracts

### Goal
Create the contracts required for a future hybrid architecture.

### Create

```text
packages/contracts
packages/api-spec
packages/events
packages/errors
packages/config
packages/logger
packages/telemetry
packages/tracing
packages/auth-client
packages/event-client
```

### Contracts
- API request/response
- Event envelope
- Error contract
- Authentication context
- Authorization context
- Trace context
- Pagination
- Idempotency
- Service metadata

### Event envelope

```text
eventId
eventType
eventVersion
occurredAt
actor
organizationId
workspaceId
aggregate
traceId
correlationId
causationId
payload
metadata
```

### Definition of Done
A future service can use the same contracts as the monolith.

---

# PHASE 3 — Runtime Context & Request Infrastructure

### Goal
Make every request and background operation traceable.

### Implement
- request ID
- trace ID
- correlation ID
- causation ID
- authenticated actor
- organization/workspace context
- service identity
- client/application identity

### Propagation

```text
Frontend
  ↓
Gateway
  ↓
Monolith / Service
  ↓
Event Bus
  ↓
Worker
  ↓
External integration
```

### Definition of Done
One user action can be followed across the entire system.

---

# PHASE 4 — Authentication & Authorization Boundary

### Goal
Separate identity and authorization concerns from business domains.

### Preserve/improve
- RS256 JWT
- JWKS
- key rotation
- `kid`
- session revocation
- 2FA/passkeys/OIDC
- RBAC
- PDP/PEP
- policy decision telemetry

### Service-ready model

```text
Identity
   ↓
Access Token
   ↓
Gateway
   ↓
Service Authorization
```

### Requirements
- Every extracted service validates authorization.
- No service trusts only the gateway.
- Internal service calls use authenticated service identity.
- Sensitive actions support step-up authorization.

---

# PHASE 5 — Database Ownership & Data Boundaries

### Goal
Stop shared database access from preventing service extraction.

### Current transition

```text
Shared PostgreSQL
       ↓
Schema ownership
       ↓
Domain-owned tables
       ↓
Service-owned schemas
       ↓
DB-per-service only when justified
```

### Rules
- One domain owns its tables.
- Other domains cannot directly write those tables.
- Read access should move toward APIs/read models/events.
- Migrations must identify owner.
- Foreign keys across future service boundaries should be reduced carefully.

### Important
Do NOT immediately create many databases.

Start with:
- one PostgreSQL cluster
- schema/domain ownership
- strict access boundaries

Move to DB-per-service only when scale, security, lifecycle or deployment independence justifies it.

---

# PHASE 6 — Event Bus & Reliable Messaging Foundation

### Goal
Make asynchronous communication production-grade.

### Existing strengths to preserve
- Outbox
- idempotency
- retry
- DLQ
- processing leases
- concurrency limits
- stale lock recovery
- retry-storm protection

### Add
- event versioning
- schema registry/contract validation
- consumer ownership
- replay
- event retention
- monitoring
- lag metrics

### Definition of Done
Events can safely cross module/service boundaries without data loss or uncontrolled duplication.

---

# PHASE 7 — Modular Monolith Internal APIs

### Goal
Make modules behave like services before physically extracting them.

### Pattern

```text
Controller
   ↓
Application API
   ↓
Domain
   ↓
Repository
```

Other modules may call only the public application API.

### Forbidden
```text
Module A → Module B repository
Module A → Module B private service
Module A → Module B DB table
```

### Allowed
```text
Module A → Module B public API
Module A → Event Bus → Module B
```

### Definition of Done
A module can later be extracted with minimal business-logic rewriting.

---

# PHASE 8 — API Gateway

### Goal
Create a stable edge boundary.

### Responsibilities
- TLS termination
- authentication
- request ID
- rate limiting
- CORS
- API versioning
- routing
- request validation
- observability

### Gateway must NOT contain
- finance business logic
- vault logic
- mail logic
- AI reasoning
- database queries
- domain workflows

### Target

```text
Client
  ↓
API Gateway
  ↓
Core Monolith / Extracted Services
```

---

# PHASE 9 — Background Worker Separation

### Goal
Separate long-running/asynchronous workloads from the web process.

### Extract first
- event consumers
- scheduled jobs
- email processing
- notification processing
- intelligence processing
- heavy analytics
- file processing
- AI jobs

### Result

```text
API Runtime
     │
     └── Event/Job Queue
              │
       ┌──────┼──────┐
       ↓      ↓      ↓
    Worker  Worker  Worker
```

This is an important hybrid architecture step without requiring microservices.

---

# PHASE 10 — Identity Service Extraction

### Goal
Extract Identity only when its boundary is stable.

### Own
- users
- credentials
- sessions
- authentication
- MFA/passkeys
- OIDC
- token issuance
- key management metadata

### APIs
```text
/login
/logout
/refresh
/session
/mfa
/oidc
/jwks
```

### Events
```text
user.created
user.updated
session.created
session.revoked
authentication.failed
```

### Migration
- Keep compatibility endpoints.
- Introduce service client.
- Dual-read only when necessary.
- Verify before removing old path.

---

# PHASE 11 — Notification Service Extraction

### Goal
Centralize delivery without mixing it with domain logic.

### Own
- notification templates
- channels
- preferences
- delivery status
- retries
- provider failures

### Channels
- Telegram
- email
- in-app
- future push/SMS where appropriate

### Event model

```text
Domain Event
   ↓
Notification Rules
   ↓
Notification Service
   ↓
Provider
```

---

# PHASE 12 — WISP Mail Service Extraction

### Goal
Make WISP a genuine domain-owned service.

### Own
- mailbox
- inbox
- sent
- drafts
- threads
- folders/labels
- archive/trash/spam
- attachments metadata
- permissions
- search
- audit

### Separate
WISP Mailbox != Mail Delivery != Notification.

### Target

```text
WISP Bot / Web
      ↓
WISP Service
      ↓
Mailbox Storage
      ↓
Event Bus
   ├── Search
   ├── Notification
   └── Mail Delivery
```

---

# PHASE 13 — Finance / RYFT Extraction

### Goal
Isolate the highest-risk financial domain.

### Own
- accounts
- transactions
- balances
- ledger
- financial policies
- reconciliation
- financial audit

### Requirements
- strict authorization
- idempotency
- transaction integrity
- immutable audit trail
- step-up authentication
- rate limits

### Rule
No other service writes RYFT financial tables.

---

# PHASE 14 — Vault / SYLO Extraction

### Goal
Isolate sensitive secret/storage functionality.

### Own
- vault records
- encryption metadata
- access policy
- secret versions
- secure attachments
- access audit

### Requirements
- envelope encryption
- key rotation
- strict authorization
- access audit
- no plaintext secrets in logs/events
- short-lived access where appropriate

---

# PHASE 15 — Workflow / SKARN Extraction

### Goal
Separate long-running automation from core request processing.

### Own
- workflows
- workflow versions
- executions
- steps
- schedules
- retries
- compensation
- execution state

### Integration

```text
API
 ↓
Workflow Service
 ↓
Queue/Event Bus
 ↓
Workers
 ↓
Domain APIs
```

### Important
Workflow workers should never directly modify another service's database.

---

# PHASE 16 — AI / ZYNTH Extraction

### Goal
Separate expensive and potentially slow AI workloads.

### Own
- agent execution
- model routing
- prompts/configuration
- tool execution policy
- usage tracking
- AI audit
- model/version metadata

### Security
- tool allowlists
- policy enforcement
- tenant isolation
- prompt/data controls
- execution timeouts
- budget/rate limits

### Architecture

```text
User
 ↓
ZYNTH API
 ↓
Policy
 ↓
AI Orchestrator
 ↓
Model / Tools
 ↓
Result + Audit Event
```

---

# PHASE 17 — Intelligence / ACIE Extraction

### Goal
Turn the intelligence engine into a separate asynchronous intelligence subsystem.

### Pipeline

```text
AYZEN Domains
     ↓
Event Bus
     ↓
Raw Event Store
     ↓
ACIE
     ↓
Persistent Intelligence Store
     ↓
Intelligence API
     ↓
Traffic Console
```

### ACIE must not
- block normal transactions
- directly execute privileged actions
- bypass policy
- own business-domain transactions

### ACIE owns
- observations
- signals
- patterns
- anomalies
- forecasts
- intelligence results
- intelligence audits
- decision/outcome learning

---

# PHASE 18 — Telegram Gateway Extraction

### Goal
Keep Telegram as a channel layer instead of mixing bot logic with domain logic.

### Architecture

```text
Telegram
   ↓
Telegram Gateway
   ↓
Identity / Workspace / Policy
   ↓
Domain API
```

### Bots
- AYZENX
- WARDE
- VERVE
- RYFT
- SYLO
- SKARN
- ZYNTH
- WISP

### Rules
- no SQL in handlers
- no business logic in handlers
- bot identity separate from user identity
- sensitive actions require confirmation/step-up auth

---

# PHASE 19 — Search / Knowledge / Analytics Read Models

### Goal
Prevent analytical and search workloads from damaging transactional systems.

### Pattern

```text
Domain Events
    ↓
Read Model Builder
    ├── Search Index
    ├── Knowledge Index
    └── Analytics Store
```

### Benefits
- faster queries
- independent scaling
- reduced DB pressure
- easier reporting
- safer historical analytics

---

# PHASE 20 — Service-to-Service Security

### Goal
Secure internal communication.

### Implement
- service identity
- short-lived service tokens
- JWKS verification
- audience validation
- issuer validation
- algorithm pinning
- mTLS later if justified
- internal authorization
- request signing where needed

### Rule
Never rely on:
```text
"If request came from internal network, trust it."
```

---

# PHASE 21 — Deployment Topology

### Goal
Introduce independent deployment without overengineering infrastructure.

### Stage 1

```text
One VM / Host
├── Gateway
├── Monolith
├── Workers
├── Identity
├── WISP
└── RYFT
```

### Stage 2

Containerize each independently.

### Stage 3
Separate compute only where justified by:
- traffic
- CPU/memory
- security
- deployment frequency
- failure isolation

### Stage 4
Kubernetes only when operational complexity is justified.

---

# PHASE 22 — Observability & Operations

### Goal
Make a hybrid system diagnosable.

### Required
- structured logs
- metrics
- traces
- request IDs
- correlation IDs
- service health
- dependency health
- queue lag
- event processing latency
- error rate
- p95/p99
- saturation
- deployment markers

### Dashboards
- platform
- API
- database
- event bus
- workers
- services
- intelligence
- security
- Telegram
- mail

---

# PHASE 23 — Contract & Integration Testing

### Goal
Prevent module/service extraction from breaking the platform.

### Tests
- unit
- integration
- API contract
- event contract
- consumer-driven contract
- authorization
- tenant isolation
- migration
- replay
- failure injection
- end-to-end

### Mandatory extraction test

```text
Old module
   ↓
Compatibility API
   ↓
New service
```

Both paths must produce equivalent expected behavior before cutover.

---

# PHASE 24 — Strangler Migration Framework

### Goal
Move functionality gradually.

### Migration pattern

```text
Existing Monolith
      ↓
Facade / Adapter
      ↓
New Service
      ↓
Traffic Migration
      ↓
Verification
      ↓
Old Code Removal
```

### Stages
1. Shadow
2. Read migration
3. Controlled write
4. Partial traffic
5. Full traffic
6. Remove old path

### Never
- big-bang rewrite
- irreversible migration
- simultaneous extraction of many dependent domains

---

# PHASE 25 — Reliability & Failure Isolation

### Goal
Ensure service failure does not become platform-wide failure.

### Implement
- timeouts
- retries with backoff
- circuit breakers
- bulkheads
- queue buffering
- DLQ
- idempotency
- graceful degradation
- dependency health checks

### Example

If Notification fails:

```text
Finance transaction
      ↓
COMMIT
      ↓
Event
      ↓
Notification unavailable
      ↓
Retry / DLQ
```

The financial transaction must not roll back merely because notification delivery failed.

---

# PHASE 26 — Data Migration & Ownership Cutover

### Goal
Move tables safely to domain ownership.

### Process

```text
Identify owner
   ↓
Add new schema
   ↓
Backfill
   ↓
Validate
   ↓
Dual-read if needed
   ↓
Controlled write
   ↓
Verify
   ↓
Remove legacy access
```

### Requirements
- checksums
- row counts
- reconciliation
- rollback plan
- migration logs
- audit

---

# PHASE 27 — Performance & Scaling Strategy

### Goal
Scale only the parts that need scaling.

### Scale independently
- API
- workers
- ACIE
- search
- mail processing
- AI
- workflow execution

### Avoid
Scaling everything independently without evidence.

### Target
Use:
- caching
- read replicas
- queue workers
- read models
- batching
- pagination
- database indexes
before creating more services.

---

# PHASE 28 — Security Hardening

### Goal
Close the distributed-system security surface.

### Verify
- CSRF strategy
- CSP
- rate limiting
- secret management
- service authentication
- authorization at service boundary
- SSRF protection
- IDOR protection
- tenant isolation
- audit logging
- sensitive-data redaction
- dependency security
- supply-chain controls

### Special attention
Service extraction increases attack surface, so security must improve with every extraction.

---

# PHASE 29 — Production Readiness

### Goal
Prove that the hybrid architecture can operate safely.

### Required
- CI checks
- migrations
- rollback
- health checks
- readiness checks
- backups
- disaster recovery
- alerting
- runbooks
- on-call procedures
- capacity planning
- incident response

### Production checklist
- [ ] No service has hidden DB dependencies.
- [ ] No service bypasses authorization.
- [ ] Events are durable.
- [ ] Retries are bounded.
- [ ] DLQ is monitored.
- [ ] All critical paths are traced.
- [ ] Deployments are reversible.
- [ ] Data migrations are reversible or recoverable.
- [ ] Service failures degrade gracefully.

---

# PHASE 30 — Final Hybrid Architecture Verification

### Goal
Confirm the system is genuinely hybrid rather than a distributed monolith.

### Verification Questions

#### Architecture
- Can core domains operate independently?
- Are boundaries enforceable?
- Are private implementations inaccessible?

#### Data
- Does each service own its data?
- Are cross-service writes prohibited?

#### Events
- Are events versioned?
- Are consumers idempotent?
- Can events be replayed?

#### Deployment
- Can extracted services deploy independently?
- Can the monolith deploy independently?

#### Security
- Does every service authenticate and authorize requests?
- Is tenant isolation verified?

#### Reliability
- Does one service failure remain isolated?
- Are retries/DLQs controlled?

#### Observability
- Can one request be traced across services?
- Can event processing be traced?

#### Testing
- Are service contracts tested?
- Are migrations verified?

---

# FINAL TARGET SERVICE MAP

The recommended end-state is selective, not maximal:

```text
CORE MODULAR MONOLITH
├── Workspace
├── User Profile
├── Common Business Domains
├── Shared Application Logic
└── Low-volume Domains

EXTRACTED SERVICES
├── Identity
├── Authorization (if operationally justified)
├── Notification
├── WISP / Mail
├── RYFT / Finance
├── SYLO / Vault
├── SKARN / Workflow
├── ZYNTH / AI
├── ACIE / Intelligence
├── Search / Knowledge (as needed)
└── Telegram Gateway

PLATFORM
├── API Gateway
├── Event Bus
├── Workers
├── Observability
└── Shared Contracts
```

# WHAT SHOULD STAY IN THE MONOLITH

Do NOT extract a service merely because a folder or engine exists.

Keep modules inside the monolith when:
- traffic is low
- scaling needs are identical
- deployment frequency is identical
- security boundary is not distinct
- data is tightly coupled
- extraction would add network complexity without benefit

Examples:
- small CRUD modules
- simple admin features
- low-volume settings
- tightly coupled workspace operations
- shared business workflows that are not independently scalable

# WHAT SHOULD BECOME A SERVICE

Extract when at least several of these are true:
- independent scaling requirement
- independent deployment requirement
- strong security boundary
- heavy workload
- different failure profile
- different data lifecycle
- clear domain ownership
- separate operational team/ownership
- external integration complexity
- expensive compute

# RECOMMENDED EXTRACTION ORDER

```text
1.  Architecture baseline
2.  Domain boundaries
3.  Contracts
4.  Request/trace context
5.  Auth boundary
6.  Database ownership
7.  Event Bus hardening
8.  Internal module APIs
9.  API Gateway
10. Worker separation
11. Identity
12. Notification
13. WISP
14. RYFT
15. SYLO
16. SKARN
17. ZYNTH
18. ACIE
19. Telegram Gateway
20. Search/Knowledge/Analytics
21. Service-to-service security
22. Deployment separation
23. Observability
24. Contract testing
25. Strangler migration
26. Failure isolation
27. Data cutover
28. Performance/scaling
29. Security hardening
30. Production verification
```

# DEFINITION OF DONE

AYZEN is considered an **Advanced Hybrid Monolith** when:

```text
Core domains
      ↓
Strong module boundaries
      ↓
Shared platform contracts
      ↓
Event-driven integration
      ↓
Independent workers
      ↓
Selected independent services
      ↓
Independent deployment where justified
      ↓
Service-owned data
      ↓
Central observability
      ↓
Reliable rollback/recovery
```

The final architecture should remain understandable.

**The objective is not "maximum microservices."**

The objective is:

> **Maximum domain independence with minimum distributed-system complexity.**

## Final Quality Gate

Before declaring the migration complete:

- Architecture: 9+/10
- Domain boundaries: 9+/10
- Event architecture: 9+/10
- Security: 9+/10
- Observability: 9+/10
- Testing: 8.5+/10
- Reliability: 8.5+/10
- Production readiness: 9+/10

And every extracted service must have:

**API + Data Ownership + Auth + Events + Observability + Tests + Migration + Rollback + Documentation.**
