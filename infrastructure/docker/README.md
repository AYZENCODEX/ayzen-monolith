# Local distributed development

The Compose file starts the public gateway, compatibility monolith, PostgreSQL,
and Redis. Extracted domain services remain opt-in until their migration gates
are complete; set their gateway URL variables only after a service has real
handlers and an owned schema adapter.

```bash
export SESSION_SECRET='local-development-only'
export POSTGRES_PASSWORD='local-development-only'
docker compose -f infrastructure/docker/docker-compose.yml up --build
```

Never commit either value or use these local values in staging or production.