# Key management

Key namespaces separate platform, identity, app, EventBus, Workflow, and Admin
material. Rotation, emergency rotation, least-privilege injection, and
redaction are required. Secrets are supplied by the runtime secrets manager,
not committed to configuration files.