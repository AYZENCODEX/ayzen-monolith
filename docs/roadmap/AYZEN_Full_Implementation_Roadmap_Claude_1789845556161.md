# AYZEN — Full Implementation Roadmap
## Modular Monolith → Microservices + 8 Telegram Bots + Personal/Business Workspaces

## Final Target
- API Gateway
- Telegram Bot Gateway
- Identity/Auth
- Authorization/Policy
- Workspace/User
- Finance
- Vault
- Workflow
- Mail
- Notification
- AI/Agent
- Marketplace
- Search/Knowledge
- Analytics
- Event Bus
- Shared contracts, auth, policy, telemetry and error packages

## Telegram Bots
1. AYZENX — Personal Workspace
2. WARDE — Organization / Business Workspace
3. VERVE — Communication / productivity
4. RYFT — Finance
5. SYLO — Secure storage / vault
6. SKARN — Automation / workflow
7. ZYNTH — AI / intelligence / agent
8. NEW TELEGRAM BOT — Newly added bot; keep the architecture extensible until its exact product responsibility is defined

The Telegram architecture must support all 8 bots through a shared Telegram Gateway and Bot Registry. Do not create a separate backend stack for each bot.

## Migration Strategy
Modular Monolith → Hardened Modular Architecture → Selective Service Extraction → Event-Driven Hybrid → Production Microservices.

Do not split every route/folder into a service. Services must represent meaningful business domains.

## Phases
0. Repository discovery and architecture baseline
1. Architectural foundation and domain boundaries
2. Security hardening
3. Authorization architecture
4. Personal/organization workspace model
5. API Gateway
6. Telegram Bot Gateway
7. Bot identity/registry
8. Identity service extraction
9. Workspace service extraction
10. Database boundaries
11. Finance service / RYFT
12. Vault service / SYLO
13. Workflow service / SKARN
14. AI/Agent service / ZYNTH
15. WISP Mailbox Service
16. Mail Delivery Service
17. Notification service
17. Event Bus
18. Outbox pattern
19. Idempotency
20. Service-to-service security
21. Observability
22. Rate limiting
23. Security hardening checklist
24. Testing strategy
25. Contract testing
26. Frontend migration
27. Telegram bot implementation
28. Shared Telegram command framework
29. Deployment strategy
30. Staging
31. Production
32. Database evolution
33. CI/CD
34. Zero-downtime migration
35. Migration order
36. Data migration
37. Failure handling
38. Health endpoints
39. Service documentation
40. Final repository structure
41. Claude execution rules
42. Definition of Done
43. Claude working method
44. Final ecosystem

## Critical Rules
- Inspect before changing.
- Do not rewrite working functionality unnecessarily.
- Preserve backward compatibility.
- One phase at a time.
- Add characterization tests before risky refactors.
- No fake microservices.
- No cross-service database access.
- No secrets in source.
- No unrestricted AI access.
- No authorization bypass.
- Telegram handlers must not contain domain logic.
- Use explicit authentication, authorization, workspace and bot context.
- Use idempotency for Telegram updates and distributed operations.
- Use outbox for important transactional events.
- Use timeouts, retries, DLQs and graceful failure handling.
- Do not start with Kubernetes unless actual requirements justify it.
- Prefer 8–15 meaningful services over dozens of tiny services.

## Telegram Flow
Telegram User + Bot + Workspace + Command
→ Telegram Gateway
→ Identity / Authorization
→ API Gateway / Domain Service
→ Event Bus where appropriate
→ Notification / Audit / Analytics.

## Security Model
RS256 JWT + JWKS + key rotation + session revocation + MFA/passkeys/OIDC where supported.
Central policy with local policy enforcement/caching.
Workspace and organization isolation enforced server-side.
Sensitive Vault/Finance/AI operations require stronger policy and, where appropriate, step-up authentication or user confirmation.

## Data Model
Start with one PostgreSQL cluster and service-owned schemas.
Do not allow Service A to query Service B tables.
Later split databases only for real scaling, isolation, compliance or reliability requirements.

## Required Service Quality
Every service should have:
- authentication
- authorization
- rate limiting
- audit logging
- structured logs
- metrics
- tracing
- health/readiness endpoints
- unit/integration/contract/security tests as applicable
- Docker/deployment configuration
- rollback documentation

## Claude Execution Protocol
For every phase:
1. Inspect current state.
2. Explain proposed change.
3. List files affected.
4. Explain architecture/security/database impact.
5. Implement incrementally.
6. Add/update tests.
7. Run lint/typecheck/tests/build/smoke checks.
8. Review diff.
9. Document changes and remaining risks.
10. Only then proceed to the next phase.

If migration risks data loss, downtime, authorization regression or security regression, stop and explain before proceeding.

## Definition of Done
Code + Tests + Security + Documentation + Observability + Migration + Rollback.

## Final Principle
The goal is not to turn AYZEN into 50–100 servers. The goal is to create well-bounded, independently deployable business capabilities while keeping one coherent identity, authorization, workspace, security and observability model.
