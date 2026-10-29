# Integration inventory

External integration families present in the monolith include:

- Telegram Bot API and webhook delivery;
- email/SMTP/IMAP/provider delivery;
- Firebase/push notification support;
- OIDC providers and passkeys;
- blockchain/wallet and marketplace providers;
- AI/model and webhook tools;
- object/attachment and vault backup destinations.

Provider credentials are deployment secrets, never source-controlled config.
Every provider integration needs timeout, retry, safe-error, audit, and
disable/failover behavior before being used by an extracted service.