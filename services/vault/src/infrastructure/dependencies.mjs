import { createHttpEnvelopeTransport } from "@ayzen/event-client";
import { createTransactionalEventPublisher } from "@ayzen/outbox";
import { createSharedIdempotencyStore } from "@ayzen/idempotency";
import { createAuditLog } from "@ayzen/service-runtime";
import { createPostgresQuery, createStateStore } from "@ayzen/service-state";

export async function createVaultDependencies({ allowMemoryState }) {
  const dbQuery = await createPostgresQuery();
  const records = await createStateStore({
    service: "vault",
    collection: "records",
    query: dbQuery,
    allowMemoryFallback: allowMemoryState,
  });
  const idempotency = await createSharedIdempotencyStore({
    service: "vault",
    query: dbQuery,
    allowMemoryFallback: allowMemoryState,
  });
  const audit = createAuditLog({ service: "vault" });
  const publish = createTransactionalEventPublisher({
    service: "vault",
    transport: createHttpEnvelopeTransport({ service: "vault" }),
  });
  return { records, idempotency, audit, publish };
}
