# Per-app API architecture

The gateway performs transport routing and request context propagation. The
owning app API performs validation, authentication, authorization, business
logic, and data access. Public, private, and internal operations are versioned
and registered; no route is authorized from an untrusted header alone.