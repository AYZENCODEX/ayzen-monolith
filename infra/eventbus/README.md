# AYZEN EventBus

The production transport is Redis Streams at `EVENT_BUS_URL`. Each domain
service uses its own consumer group so the same event fans out to every
declared consumer; replicas of one service share a group and compete for work.

Streams are created lazily as event types are published or subscribed. Consumer
groups retain pending entries across process restarts. A restarted consumer
claims entries idle for at least 30 seconds, retries poison messages up to the
policy limit, and then writes the full envelope to `ayzen:events:dead-letter`.

Operators can inspect or replay dead letters through the event-client
`deadLetters()` and `replayDeadLetter({ eventId })` methods. Replays preserve
the original event ID so idempotent consumers remain safe.

Local development may explicitly use `ALLOW_EVENTBUS_NOOP=true`; deployed
services must provide a reachable `EVENT_BUS_URL`.