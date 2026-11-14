#!/usr/bin/env node
/**
 * scripts/smoke-oidc-endpoints.mjs — W1-P3 "Done" check, run against a LIVE deployment.
 *
 *   node scripts/smoke-oidc-endpoints.mjs https://api.ayzen.tech [--skip-register]
 *
 * 1. GET {base}/.well-known/openid-configuration  -> 200 JSON, `issuer` is a valid origin.
 * 2. For every endpoint URL the document advertises, send the advertised method with NO credentials and NO
 *    parameters and require that the route EXISTS: any HTTP answer except 404/405/5xx counts (a bare call is
 *    expected to be refused with 400/401/403/302 — that is the route doing its job). 404/405 means the document
 *    advertises something that does not resolve; 5xx means it resolves but is broken.
 * 3. Hosts: every advertised URL must be on the issuer's origin, and the issuer must equal the host being probed
 *    unless --issuer-differs is passed (gateway/CDN setups).
 *
 * Nothing is created or changed: bare requests fail validation first. `--skip-register` leaves POST /oidc/register
 * alone anyway, because it sits behind a per-IP-per-hour limiter you may not want to spend.
 * Exit code 0 = all resolve, 1 = a problem, 2 = usage. Install-free (Node >= 18 fetch).
 */
const METHODS = {
  jwks_uri: "GET",
  authorization_endpoint: "GET",
  token_endpoint: "POST",
  userinfo_endpoint: "GET",
  end_session_endpoint: "GET",
  introspection_endpoint: "POST",
  revocation_endpoint: "POST",
  registration_endpoint: "POST",
};

export async function smoke(base, { skipRegister = false, issuerDiffers = false, fetchImpl = fetch, log = () => {} } = {}) {
  const problems = [];
  const results = [];
  const root = base.replace(/\/+$/, "");
  const discoveryUrl = `${root}/.well-known/openid-configuration`;
  let doc;
  try {
    const r = await fetchImpl(discoveryUrl, { redirect: "manual", headers: { accept: "application/json" } });
    if (r.status !== 200) problems.push(`GET ${discoveryUrl} -> ${r.status} (expected 200)`);
    else if (!/application\/json/i.test(r.headers.get("content-type") || "")) problems.push(`discovery content-type is '${r.headers.get("content-type")}', expected application/json`);
    else doc = await r.json();
  } catch (e) { problems.push(`GET ${discoveryUrl} failed: ${e.message}`); }
  if (!doc) return { ok: false, problems, results };

  let issuerUrl;
  try { issuerUrl = new URL(doc.issuer); } catch { problems.push(`issuer '${doc.issuer}' is not an absolute URL`); return { ok: false, problems, results }; }
  if (issuerUrl.protocol !== "https:" && issuerUrl.hostname !== "localhost" && issuerUrl.hostname !== "127.0.0.1") problems.push(`issuer must be https: ${doc.issuer}`);
  if (!issuerDiffers && issuerUrl.host !== new URL(root).host) problems.push(`issuer host ${issuerUrl.host} != probed host ${new URL(root).host} (pass --issuer-differs if intended)`);

  for (const [field, method] of Object.entries(METHODS)) {
    const url = doc[field];
    if (typeof url !== "string") { problems.push(`discovery has no '${field}'`); continue; }
    if (!url.startsWith(doc.issuer.replace(/\/+$/, "") + "/")) problems.push(`${field} (${url}) is not under the issuer ${doc.issuer}`);
    if (field === "registration_endpoint" && skipRegister) { results.push({ field, url, skipped: true }); continue; }
    // Probe via the probed host, not the issuer host, so a not-yet-DNS'd issuer is still testable: path only.
    const target = root + new URL(url).pathname;
    try {
      const r = await fetchImpl(target, { method, redirect: "manual", headers: method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}, body: method === "POST" ? "" : undefined });
      results.push({ field, url: target, method, status: r.status });
      log(`${method} ${target} -> ${r.status}`);
      if (r.status === 404 || r.status === 405) problems.push(`${field}: ${method} ${target} -> ${r.status} (advertised but does not resolve)`);
      else if (r.status >= 500) problems.push(`${field}: ${method} ${target} -> ${r.status} (resolves but errors)`);
    } catch (e) { problems.push(`${field}: ${method} ${target} failed: ${e.message}`); }
  }
  return { ok: problems.length === 0, problems, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const base = args.find((a) => !a.startsWith("--"));
  if (!base) { console.error("usage: node scripts/smoke-oidc-endpoints.mjs <base-url> [--skip-register] [--issuer-differs]"); process.exit(2); }
  const { ok, problems, results } = await smoke(base, { skipRegister: args.includes("--skip-register"), issuerDiffers: args.includes("--issuer-differs"), log: console.log });
  for (const r of results.filter((x) => x.skipped)) console.log(`SKIP ${r.field}`);
  if (!ok) { console.error("\nFAILED:\n" + problems.map((p) => "  - " + p).join("\n")); process.exit(1); }
  console.log(`\nOK: discovery document and all ${results.length} advertised endpoints resolve.`);
}
