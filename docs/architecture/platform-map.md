# Platform and app boundary map

The platform is a gateway-fronted modular monolith with independently runnable
service boundaries. Apps own their API, policy, data, and security context.
Identity, authorization, EventBus, Workflow, audit, intelligence, and the
network hub are shared capabilities consumed through contracts.

The combined backbone circuit is registered in
`infrastructure/platform/roadmap-api-security-eventbus-workflow-1-50.json`.