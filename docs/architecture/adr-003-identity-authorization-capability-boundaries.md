# ADR-003: Identity, authorization, and capability boundaries

## Decision

AYZEN uses one stable internal user identity across website, admin, and
Telegram. Telegram numeric user IDs are stored as verified links to that
identity; usernames are display metadata only.

Authorization is evaluated by capability and scope before a domain operation is
called. Sensitive capabilities require a recent step-up timestamp. Domain
ownership and resource checks remain in the domain service.

The API capability registry is the source of truth for whether an operation is
available to clients and bots. A bot may not implement a missing domain
capability locally.

## Consequences

- authentication context can be shared without sharing domain repositories
- authorization decisions are auditable and testable independently of transport
- Telegram can report an unavailable capability without silently bypassing the API
- partial capability work remains visible until its backend and migration gates pass