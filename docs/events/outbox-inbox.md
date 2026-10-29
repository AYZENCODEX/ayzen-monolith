# Transactional outbox and inbox

State-changing operations append an outbox record in the same transaction
boundary as domain state. Publishers claim and acknowledge records; consumers
deduplicate through inbox keys. Failed records retry and eventually enter a
controlled dead-letter state.