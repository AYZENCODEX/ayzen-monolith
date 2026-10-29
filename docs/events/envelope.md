# Event envelope

Every event carries ID, type, version, source/owner, subject or aggregate,
app and tenant context, trace/correlation/causation IDs, timestamp, payload,
and security classification. Consumers validate the envelope before handling.