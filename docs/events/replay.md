# Replay and archive

Events are archived with their original identity and trace context. Replay is
selective, operator-controlled, and requires idempotent consumers. Reprocessing
never bypasses authorization or creates an unbounded duplicate effect.