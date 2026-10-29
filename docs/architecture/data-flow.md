# AYZEN data flow

## Authenticated HTTP

```text
Client -> Gateway -> Monolith or approved service
                  -> identity verification
                  -> workspace context
                  -> policy enforcement
                  -> domain mutation
                  -> audit + outbox event
```

## Telegram

```text
Telegram -> webhook secret verification
         -> bot registry and update normalization
         -> durable update-id claim
         -> Telegram identity/workspace context
         -> policy check
         -> domain command
         -> audit/event/notification
```

## Event delivery

```text
Domain transaction -> business row + event_outbox row
                   -> leased dispatcher
                   -> consumer idempotency
                   -> retry/backoff or dead letter
```

Sensitive values stay within the owning domain. Logs and events carry
identifiers and metadata, not passwords, private keys, vault plaintext, or bot
tokens.