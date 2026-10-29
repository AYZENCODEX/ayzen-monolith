# AYZEN services

Each directory is an independently runnable process boundary. The service
runtime supplies transport probes, structured lifecycle logs, graceful
shutdown, and a manifest. Domain handlers must be added only with their
ownership registry, event contracts, authorization checks, and migration gates.

The gateway keeps all routes on the compatibility monolith until an extracted
service URL is explicitly configured.