# AYZEN dependency map

```text
Web / Admin / Telegram
          |
      API Gateway
          |
  +-------+-----------------------------+
  |                                     |
Monolith                         Extracted boundaries
  |                                     |
Identity -> Workspace -> Policy    Finance / Vault / Mail
  |          |                      Workflow / AI / Search
  +----------+----------+           Notification / Marketplace
             |
       Domain database
             |
       Transactional outbox -> Event bus -> consumers
```

Rules:

- Clients depend on gateway-owned paths, never service URLs.
- Domains may publish versioned events but may not read another domain's tables.
- Identity issues tokens; services verify them with public keys/JWKS.
- Telegram handlers translate channel input and call domain APIs; they do not
  contain business SQL.
- Extracted services must not import `artifacts/api-server`.