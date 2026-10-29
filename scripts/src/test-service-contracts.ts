import assert from "node:assert/strict";
import {
  DOMAIN_SERVICE_CONTRACTS,
} from "../../artifacts/api-server/src/lib/domain-service-contracts";
import { getServiceDescriptor } from "../../artifacts/api-server/src/lib/architecture/domains";
import {
  signServiceRequest,
  verifyServiceSignature,
  hashRequestBody,
} from "../../artifacts/api-server/src/lib/service-to-service-security";
import { assertTableOwnedBy, getTableOwner } from "../../artifacts/api-server/src/lib/service-boundaries";
import {
  ROADMAP_PHASES_10_25,
  getRoadmapReadiness,
  getRegisteredEventTypes,
} from "../../artifacts/api-server/src/lib/roadmap-contracts";
import {
  MIGRATION_ROUTES,
  canAdvanceMigration,
} from "../../artifacts/api-server/src/lib/migration-registry";

const secret = "contract-test-secret";
const signatureInput = {
  service: "finance",
  method: "POST",
  path: "/internal/finance/ledger",
  timestamp: Date.now(),
  requestId: "request-1",
  body: { amount: 10, currency: "USD" },
};

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn).then(
    () => console.log(`  ok — ${name}`),
    (error) => {
      console.error(`  FAIL — ${name}`);
      throw error;
    },
  );
}

async function main(): Promise<void> {
  console.log("Roadmap phases 10-25 — service contract tests");

  await test("every declared service has an extraction descriptor and contract", () => {
    assert.equal(DOMAIN_SERVICE_CONTRACTS.length, 15);
    for (const contract of DOMAIN_SERVICE_CONTRACTS) {
      assert.ok(getServiceDescriptor(contract.service));
      assert.ok(contract.capabilities.length > 0);
      assert.ok(contract.tables.length > 0);
      assert.equal(contract.qualityGates.length, 9);
    }
  });

  await test("database ownership is explicit and rejects cross-service access", () => {
    assert.equal(getTableOwner("finance_ledger_entries"), "finance");
    assert.doesNotThrow(() => assertTableOwnedBy("finance", "finance_ledger_entries"));
    assert.throws(
      () => assertTableOwnedBy("vault", "finance_ledger_entries"),
      /Database boundary violation/,
    );
  });

  await test("service signatures are deterministic and tamper-evident", () => {
    const timestamp = String(signatureInput.timestamp);
    const bodyHash = hashRequestBody(signatureInput.body);
    const signature = signServiceRequest({
      service: signatureInput.service,
      timestamp,
      requestId: signatureInput.requestId,
      bodyHash,
      secret,
    });
    assert.equal(verifyServiceSignature({
      service: signatureInput.service,
      timestamp,
      requestId: signatureInput.requestId,
      bodyHash,
      signature,
      secret,
    }), true);
    assert.equal(
      verifyServiceSignature({
        service: signatureInput.service,
        timestamp,
        requestId: signatureInput.requestId,
        bodyHash: hashRequestBody({ amount: 11, currency: "USD" }),
        signature,
        secret,
      }),
      false,
    );
    assert.equal(verifyServiceSignature({
      service: signatureInput.service,
      timestamp,
      requestId: signatureInput.requestId,
      bodyHash,
      signature,
      secret: "wrong-secret",
    }), false);
  });

  await test("service request body hashing is key-order independent", () => {
    assert.equal(
      hashRequestBody({ amount: 10, currency: "USD" }),
      hashRequestBody({ currency: "USD", amount: 10 }),
    );
  });

  await test("roadmap phases 10-25 have explicit acceptance contracts", () => {
    assert.deepEqual(
      ROADMAP_PHASES_10_25.map((phase) => phase.phase),
      Array.from({ length: 16 }, (_, index) => index + 10),
    );
    const readiness = getRoadmapReadiness();
    assert.equal(readiness.ready, true);
    assert.ok(getRegisteredEventTypes().includes("finance.transaction.created"));
    assert.ok(getRegisteredEventTypes().includes("wisp.message.received"));
  });

  await test("strangler migration requires every safety gate before cutover", () => {
    assert.equal(MIGRATION_ROUTES.length >= 8, true);
    assert.equal(canAdvanceMigration("monolith", "dual_read", []), false);
    assert.equal(
      canAdvanceMigration("monolith", "dual_read", ["backup", "characterization", "backfill", "validation", "rollback"]),
      true,
    );
    assert.equal(canAdvanceMigration("monolith", "write_switched", ["backup", "characterization", "backfill", "validation", "rollback"]), false);
  });
}

main().catch(() => process.exitCode = 1);