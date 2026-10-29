# Event, queue, and workflow reliability

Events use an explicit envelope, at-least-once delivery assumptions, replay,
idempotent consumers, outbox/inbox semantics, leases, retries, dead letters,
and auditable workflow transitions.

The envelope contract is in `config/antas/event-envelope.json`; runtime
replay and crash drills remain provider/runtime gates.