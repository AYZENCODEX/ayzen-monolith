# Service extraction exit criteria

A service is not cut over merely because an entrypoint exists. It needs API,
database, migration, authorization, event, observability, test, load,
rollback, fallback, and reconciliation evidence. The compatibility monolith
remains the default until those gates pass.