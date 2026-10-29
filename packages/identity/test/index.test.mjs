import test from "node:test";
import assert from "node:assert/strict";
import { createHybridIdentityRegistry } from "../src/index.mjs";

function activeLocal(registry, appId = "ryft") {
  const local = registry.createLocalAccount({ appId, ownerId: "user-1" });
  registry.transitionLocalAccount(local.id, "active", { type: "user", id: "user-1" });
  return local.id;
}

test("supports local accounts without requiring AYZEN", () => {
  const registry = createHybridIdentityRegistry();
  const localId = activeLocal(registry);
  assert.deepEqual(registry.resolveAccount({ appId: "ryft", localIdentityId: localId }).outcome, "local");
  assert.equal(registry.getLocalAccount(localId).state, "active");
});

test("requires explicit verified linking and never links by email", () => {
  const registry = createHybridIdentityRegistry();
  const localId = activeLocal(registry);
  const ayzenId = registry.registerVerifiedAyzenIdentity({
    issuer: "https://id.ayzen.test",
    subject: "central-user-1",
    claims: { email: "same@example.test" },
  }).id;
  assert.equal(registry.resolveAccount({ appId: "ryft", ayzenIdentityId: ayzenId, localIdentityId: localId }).outcome, "explicit_link_required");
  assert.throws(() => registry.createIdentityLink({ appId: "ryft", localIdentityId: localId, ayzenIdentityId: ayzenId }), /confirmation/);
  const link = registry.createIdentityLink({ appId: "ryft", localIdentityId: localId, ayzenIdentityId: ayzenId, confirmation: true });
  assert.equal(registry.resolveAccount({ appId: "ryft", ayzenIdentityId: ayzenId }).identityId, localId);
  assert.equal(link.state, "active");
});

test("keeps profile sync consented and app-owned fields authoritative", () => {
  const registry = createHybridIdentityRegistry();
  const localId = activeLocal(registry);
  registry.updateLocalProfile({ identityId: localId, fields: { displayName: "Local name" } });
  const result = registry.syncApprovedProfile({
    identityId: localId,
    consent: true,
    claims: { name: "Central name", picture: "avatar" },
    mappings: {
      name: { field: "displayName", source: "ayzen", authoritative: true, appOwned: true },
      picture: { field: "avatarUrl", source: "ayzen", authoritative: true },
    },
  });
  assert.deepEqual(result.fields, ["avatarUrl"]);
  assert.equal(result.profile.displayName, "Local name");
});

test("enforces app-scoped sessions, expiry, revocation, and logout-all", () => {
  const registry = createHybridIdentityRegistry({ now: (() => { let time = 1_000; return () => time; })() });
  const localId = activeLocal(registry);
  const session = registry.createSession({ appId: "ryft", identityId: localId, token: "secret-token", deviceId: "device-1" });
  assert.equal(registry.assertSession({ sessionId: session.id, appId: "ryft", token: "secret-token" }).identityId, localId);
  assert.throws(() => registry.assertSession({ sessionId: session.id, appId: "sylo", token: "secret-token" }), /Session/);
  assert.deepEqual(registry.revokeAllSessions(localId), [session.id]);
  assert.throws(() => registry.assertSession({ sessionId: session.id, appId: "ryft", token: "secret-token" }), /Session/);
});

test("rejects cross-app links and records privacy-safe audit events", () => {
  const registry = createHybridIdentityRegistry();
  const localId = activeLocal(registry, "ryft");
  const ayzenId = registry.registerVerifiedAyzenIdentity({ issuer: "https://id.ayzen.test", subject: "central-user-2" }).id;
  assert.throws(() => registry.createIdentityLink({ appId: "sylo", localIdentityId: localId, ayzenIdentityId: ayzenId, confirmation: true }), /another app/);
  assert.ok(registry.listAudit().every((record) => !JSON.stringify(record).includes("secret-token")));
});