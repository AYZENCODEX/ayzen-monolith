# AYZEN extracted service template

Copy this package for a domain extraction only after its characterization,
backfill, validation, and rollback gates are complete. The runtime provides
transport probes and an independent process boundary; it intentionally does
not invent domain behavior or bypass the monolith.