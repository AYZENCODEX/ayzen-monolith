#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHybridIdentityRegistry } from "../packages/identity/src/index.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};
const readJson = (relativePath) => {
  try {
    return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
};
const readText = (relativePath) => {
  try {
    return readFileSync(resolve(root, relativePath), "utf8");
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return "";
  }
};

const manifest = readJson("infrastructure/platform/hybrid-identity-manifest.json");
const ownership = readJson("infrastructure/platform/identity-ownership.json");
const policy = readJson("infrastructure/platform/identity-policy.json");
const events = readJson("infrastructure/platform/identity-event-contract.json");

check(manifest?.phaseRange?.[0] === 1 && manifest?.phaseRange?.[1] === 15, "manifest must cover phases 1-15");
check(Array.isArray(manifest?.phases) && manifest.phases.length === 15, "manifest must contain exactly 15 phases");
check(manifest?.status === "implemented-and-governed", "manifest status must be implemented-and-governed");
check(manifest?.engine === "packages/identity/src/index.mjs", "manifest must point to the executable identity engine");
check(JSON.stringify(manifest?.finalCircuit) === JSON.stringify([
  "user", "ayzen-or-local-authentication", "identity-resolver", "connected-or-local-app-identity",
  "app-session", "app-policy", "feature", "sub-feature", "function", "api", "service", "db",
  "eventbus", "workflow", "audit", "intelligence", "admin-telegram",
]), "identity final circuit must be complete and ordered");

for (const phase of manifest?.phases ?? []) {
  check(Number.isInteger(phase.phase) && phase.phase >= 1 && phase.phase <= 15, `invalid phase number: ${phase.phase}`);
  check(phase.status === "implemented", `phase ${phase.phase} is not implemented`);
  for (const evidence of phase.evidence ?? []) {
    check(existsSync(resolve(root, evidence)), `phase ${phase.phase} evidence is missing: ${evidence}`);
  }
}

const requiredRules = [
  "email or username matching never creates an identity link",
  "AYZEN-owned claims cannot silently overwrite app-owned fields",
  "authentication, app membership, roles, and feature permissions remain separate",
];
for (const rule of requiredRules) check(manifest?.rules?.includes(rule), `missing manifest rule: ${rule}`);
check(ownership?.defaultDeny === true, "identity ownership must be default-deny");
check(policy?.defaultDeny === true && policy?.authenticationDoesNotGrantAppAccess === true, "identity policy must separate auth from authorization");
check(policy?.linking?.emailMatchIsInsufficient === true, "identity policy must reject email-only linking");
check(events?.privacy === "no-credentials-or-raw-tokens", "identity event contract must exclude credentials and raw tokens");
check(Array.isArray(events?.events) && events.events.length >= 10, "identity event contract is incomplete");

const authClient = readText("packages/auth-client/src/index.mjs");
check(authClient.includes("verifyRs256Jwt") && authClient.includes("createJwksAuthenticator"), "RS256/JWKS foundation is not registered");
const authUtils = readText("artifacts/api-server/src/lib/auth-utils.ts");
check(authUtils.includes("getTokenFromReq") && authUtils.includes("verifyOidcAccessToken"), "API authentication seam is not registered");
const authorization = readText("packages/authorization/src/index.mjs");
check(authorization.includes("APP_POLICY_PACKS") && authorization.includes("defaultDeny: true"), "per-app default-deny policy packs are not registered");
const eventRuntime = readText("packages/events/src/index.mjs");
check(eventRuntime.includes("session.revoked") && eventRuntime.includes("identity.telegram.linked"), "event runtime identity foundations are not registered");
const telegram = readText("packages/telegram/src/index.mjs");
check(telegram.includes("assertTelegramSession") && telegram.includes("assertAdminTelegramOwner"), "Telegram identity/session controls are not registered");

try {
  execFileSync(process.execPath, ["--test", "packages/identity/test/index.test.mjs"], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
} catch (error) {
  errors.push(`identity domain tests failed: ${error.stdout ?? error.message}`);
}

const registry = createHybridIdentityRegistry();
const local = registry.createLocalAccount({ appId: "ryft", ownerId: "owner-1" });
registry.transitionLocalAccount(local.id, "active", { type: "user", id: "owner-1" });
const central = registry.registerVerifiedAyzenIdentity({ issuer: "https://id.ayzen.test", subject: "sub-1" });
check(registry.resolveAccount({ appId: "ryft", ayzenIdentityId: central.id }).outcome === "offer_connect_or_create_local", "unlinked AYZEN resolution must offer a choice");
check(registry.resolveAccount({ appId: "ryft", ayzenIdentityId: central.id, localIdentityId: local.id }).outcome === "explicit_link_required", "linking must be explicit");
const link = registry.createIdentityLink({ appId: "ryft", localIdentityId: local.id, ayzenIdentityId: central.id, confirmation: true });
check(registry.resolveAccount({ appId: "ryft", ayzenIdentityId: central.id }).identityId === local.id, "active link must resolve to local identity");
registry.revokeIdentityLink(link.id, { confirmation: true, actor: { type: "user", id: "owner-1" } });
check(registry.resolveAccount({ appId: "ryft", ayzenIdentityId: central.id }).outcome === "offer_connect_or_create_local", "revoked link must not resolve");

if (errors.length) {
  console.error(`Hybrid identity validation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Hybrid identity validation passed: 15 phases, explicit linking, app-scoped sessions, policy separation, ownership, events, Telegram controls, and domain tests.");