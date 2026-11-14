// scripts/src/seed-oidc-clients.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 2B: First-Party Seed Data (2B-a..2B-e).
//
// Registers AYZEN's five first-party subdomain apps — Sylo, Ryft, Wisp,
// Verve, Zynth — as rows in `oidc_clients` (migration 079, Phase 2A). These
// are the same five apps CHANGES_SYLO_SUBDOMAIN_SPLIT.md's
// `subdomain-app.ts` already names as the next hostname splits
// (`ryft.ayzen.tech`, `wisp.ayzen.tech`, `verve.ayzen.tech`,
// `zynth.ayzen.tech`, alongside the already-split `sylo.ayzen.tech`) — this
// is the OIDC-registry side of that same set of apps, not a new list.
//
// EVERY SEEDED CLIENT IS
//   - `is_first_party: true`.
//   - `clientSecretHash: null` — a public client, PKCE-only. All five are
//     the same browser-served SPA bundle (see subdomain-app.ts) scoped by
//     hostname; there's no server-side place to keep a confidential secret
//     for any of them. PKCE — mandatory for first-party clients per the
//     roadmap's global security section 3.2 — is the proof of possession
//     instead. This mirrors the `client_secret_hash` nullability decision
//     already documented in Phase 2A-a's schema.
//   - `allowedScopes: ["openid", "profile", "email"]` — `lib/oidc-
//     discovery.ts`'s SCOPES_SUPPORTED is `["openid"]` only today, and its
//     own comment says adding "profile"/"email" there is explicitly
//     "Phase 2's job (client `allowed_scopes` registry)". Seeded here now
//     so Phase 4's userinfo endpoint has real registry data to check
//     against once it exists, instead of needing a second seed pass.
//   - `redirectUris`: a single production callback,
//     `https://<client_id>.ayzen.tech/oidc/callback`. That route doesn't
//     exist yet (Phase 3 builds `/oidc/authorize` and the client-side
//     callback handler) — this is registry data ahead of the flow, the
//     same relationship migration 079 already has to the not-yet-built
//     `/oidc/authorize`. A dev/local redirect URI can be appended later
//     (once Phase 3 exists to actually test against) without a schema
//     change — `redirect_uris` is a plain JSONB array column.
//   - `postLogoutRedirectUris` (Season 3, Phase 6a-d, migration 084): a
//     single production landing page, `https://<client_id>.ayzen.tech/` —
//     each app's own home page, the obvious "where does a signed-out user
//     land" target for a first-party SPA with no separate marketing site.
//     Kept as its own column rather than reusing `redirectUris` — see
//     migration 084's own header for why RP-Initiated Logout's registered
//     list is deliberately independent from the OAuth callback allow-list.
//
// NOT SEEDED HERE (out of 2B's scope)
//   - No admin UI (roadmap 2b-f: "No admin UI").
//   - No client actually calling `/oidc/authorize` with these credentials
//     — nothing reads this table yet except Phase 2A-c's
//     `getOidcClientById()`/`oidcClientExists()`, and nothing calls those
//     from a route yet either.
//
// IDEMPOTENT: `INSERT .. ON CONFLICT (client_id) DO UPDATE`, safe to re-run
// (e.g. after editing SEED_CLIENTS below) without a separate "already
// seeded" check first. Re-running deliberately never touches
// `client_secret_hash` on conflict — see the DO UPDATE clause below — so a
// secret hash set by some later, out-of-band process for one of these
// clients is never silently wiped out by a reseed.
//
// Usage:
//   npx tsx scripts/src/seed-oidc-clients.ts [--dry-run]
//
//   --dry-run: prints what would be written, writes nothing.

import { pool } from "@workspace/db";

import { SEED_CLIENTS, type SeedClient } from "./oidc-seed-clients-data";

// W1-P3: the client definitions moved to ./oidc-seed-clients-data.ts (pure data, derived from
// packages/module-registry). Re-exported so every existing importer keeps working.
export { SEED_CLIENTS };
export type { SeedClient };

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  console.log(
    `[seed-oidc-clients] ${SEED_CLIENTS.length} first-party client(s) to seed: ${SEED_CLIENTS.map((c) => c.clientId).join(", ")}`,
  );

  if (dryRun) {
    for (const c of SEED_CLIENTS) {
      console.log(
        `[seed-oidc-clients] --dry-run: would upsert client_id='${c.clientId}' (${c.label}) ` +
          `redirect_uris=${JSON.stringify(c.redirectUris)} post_logout_redirect_uris=${JSON.stringify(c.postLogoutRedirectUris)} ` +
          `backchannel_logout_uri=${c.backchannelLogoutUri ?? "NULL"} ` +
          `allowed_scopes=${JSON.stringify(c.allowedScopes)} ` +
          `is_first_party=${c.isFirstParty} client_secret_hash=NULL`,
      );
    }
    console.log("[seed-oidc-clients] --dry-run: stopping here. No rows written.");
    return;
  }

  let upserted = 0;
  for (const c of SEED_CLIENTS) {
    try {
      await pool.query(
        `INSERT INTO oidc_clients (client_id, client_secret_hash, registration_status, redirect_uris, post_logout_redirect_uris, backchannel_logout_uri, allowed_scopes, is_first_party, updated_at)
         VALUES ($1, $2, 'approved', $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, NOW())
         ON CONFLICT (client_id) DO UPDATE SET
           -- W1-P3: a seeded first-party client stuck in 'pending' (inserted after migration 091 by an older seed that never set the
           -- column) is repaired; 'approved' stays, and 'suspended' is an admin's decision a re-seed must NEVER undo.
           registration_status = CASE WHEN oidc_clients.registration_status = 'pending' THEN 'approved' ELSE oidc_clients.registration_status END,
           redirect_uris = EXCLUDED.redirect_uris,
           post_logout_redirect_uris = EXCLUDED.post_logout_redirect_uris,
           backchannel_logout_uri = EXCLUDED.backchannel_logout_uri,
           allowed_scopes = EXCLUDED.allowed_scopes,
           is_first_party = EXCLUDED.is_first_party,
           updated_at = NOW()`,
        [
          c.clientId,
          c.clientSecretHash,
          JSON.stringify(c.redirectUris),
          JSON.stringify(c.postLogoutRedirectUris),
          c.backchannelLogoutUri,
          JSON.stringify(c.allowedScopes),
          c.isFirstParty,
        ],
      );
      upserted += 1;
      console.log(`[seed-oidc-clients] client_id='${c.clientId}' (${c.label}) upserted.`);
    } catch (err) {
      console.error(`[seed-oidc-clients] failed to upsert client_id='${c.clientId}':`, err);
    }
  }

  console.log(`[seed-oidc-clients] done — ${upserted}/${SEED_CLIENTS.length} client(s) upserted.`);
}

main()
  .catch((err) => {
    console.error("[seed-oidc-clients] unexpected error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
