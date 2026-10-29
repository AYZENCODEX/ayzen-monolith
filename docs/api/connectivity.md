# App connectivity layer

`packages/connectivity` governs API and EventBus connections using registered
source, target, transport, audience, scopes, resources, and tenant trace
context. It prevents direct database coupling and emits receipts for
idempotent cross-app delivery.