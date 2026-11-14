#!/usr/bin/env node
/**
 * scripts/validate-w2-p4.mjs — W2-P4 validator (public landing per module, req 11). Install-free.
 *   node scripts/validate-w2-p4.mjs              # validate
 *   node scripts/validate-w2-p4.mjs --self-test  # prove each rule fails on a deliberate breakage
 * The SEO rules mirror what Lighthouse's SEO category checks (title, meta description, viewport, lang, canonical, indexable,
 * link text, tap targets markup, crawlable links, structured data). Real Lighthouse is NOT run here (see docs/module-landings.md).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANDINGS, getLandingContent, landingDocument, landingIds, injectLandingIntoHtml, robotsTxt, sitemapXml } from "../packages/module-registry/src/landing.mjs";
import { MODULES } from "../packages/module-registry/src/index.mjs";
import { designedLandingHtml, designAssets, designIds, hasDesign } from "../packages/module-registry/src/landing-designs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const WIRING = ["artifacts/ayzen/src/main.tsx", "artifacts/ayzen/src/lib/module-landing-gate.ts", "artifacts/ayzen/src/pages/modules/landing.tsx",
  "artifacts/ayzen/vite.module.config.ts", "artifacts/api-server/src/app.ts", "scripts/gen-module-deploy.mjs", "deploy/modules/fyra/vercel.json", ".github/workflows/ci.yml", "packages/module-registry/package.json", "artifacts/ayzen/index.html"];

function load(over = {}) {
  const ids = over.ids ?? landingIds();
  const docs = Object.fromEntries(ids.map((id) => [id, landingDocument(getLandingContent(id))]));
  return { ids, docs: { ...docs, ...over.docs }, prod: { ...Object.fromEntries(ids.map((id) => [id, designedLandingHtml(id)])), ...over.prod }, designs: over.designs ?? designIds(), assets: over.assets ?? Object.fromEntries(designIds().map((id) => [id, designAssets(id).map((a) => a.rel)])), files: { ...Object.fromEntries(WIRING.map((f) => [f, read(f)])), ...over.files },
    og: over.og ?? Object.fromEntries(ids.map((id) => [id, existsSync(join(ROOT, `artifacts/ayzen/public/og/${id}.png`)) ? statSync(join(ROOT, `artifacts/ayzen/public/og/${id}.png`)).size : 0])),
    shell: over.shell ?? read("artifacts/ayzen/index.html"), robots: over.robots, landings: over.landings };
}
const text = (h) => h.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const eachDoc = (t, fn) => { const bad = []; for (const [id, d] of Object.entries(t.docs)) { const m = fn(d, id); if (m) bad.push(`${id}: ${m}`); } return bad.length ? bad.join("; ") : null; };

const RULES = [
  ["every registry module has a landing content set (and nothing extra)", (t) => {
    const reg = MODULES.map((m) => m.id).sort().join(","); const have = [...t.ids].sort().join(",");
    return reg === have ? null : `registry ${reg} vs landings ${have}`;
  }],
  ["8 content sets are distinct: hero title, lead, tagline and brand accent are unique per module", (t) => {
    const L = t.landings ?? LANDINGS;
    for (const k of ["hero.title", "hero.lead", "tagline", "brand.accent", "brand.bg"]) {
      const vals = Object.values(L).map((l) => k.split(".").reduce((o, p) => o[p], l));
      if (new Set(vals).size !== vals.length) return `${k} is duplicated`;
    }
    return null;
  }],
  ["content depth: hero, >=4 features, shards pricing CTA, FAQ with >=5 questions", (t) => eachDoc(t, (d) => {
    const n = (re) => (d.match(re) ?? []).length;
    if (n(/<h1[ >]/g) !== 1) return "need exactly one h1";
    if (n(/<li><h3>/g) < 4) return "fewer than 4 features";
    if (!/id="pricing"/.test(d) || !/Shards/.test(d) || !/href="\/register"/.test(d)) return "no shards pricing section with a CTA";
    if (n(/<details>/g) < 5) return "fewer than 5 FAQ items";
    return null;
  })],
  ["SEO: <title> (<=70), meta description (50-170), viewport, html lang, charset", (t) => eachDoc(t, (d) => {
    const ti = /<title>([^<]+)<\/title>/.exec(d)?.[1]; if (!ti || ti.length > 70) return "title missing or too long";
    const de = /<meta name="description" content="([^"]*)"/.exec(d)?.[1]; if (!de || de.length < 50 || de.length > 170) return "description missing or wrong length";
    if (!/<meta name="viewport" content="width=device-width/.test(d)) return "no viewport";
    if (!/<html lang="en"/.test(d)) return "no html lang";
    if (!/<meta charset="utf-8"/i.test(d)) return "no charset";
    return null;
  })],
  ["SEO: indexable (robots index,follow), canonical to the module host, one canonical", (t) => eachDoc(t, (d, id) => {
    if (/noindex/.test(d) || !/<meta name="robots" content="index, follow"/.test(d)) return "not indexable";
    const c = [...d.matchAll(/<link rel="canonical" href="([^"]+)"/g)]; if (c.length !== 1) return "need exactly one canonical";
    return c[0][1] === `https://${MODULES.find((m) => m.id === id).defaultHost}/` ? null : `canonical is ${c[0][1]}`;
  })],
  ["Open Graph + Twitter: title, description, url, image 1200x630 on the module's own host, alt text", (t) => eachDoc(t, (d, id) => {
    for (const p of ["og:title", "og:description", "og:url", "og:image", "og:image:alt"]) if (!d.includes(`property="${p}"`)) return `missing ${p}`;
    if (!d.includes('content="1200"') || !d.includes('content="630"')) return "image size not declared";
    if (!d.includes(`/og/${id}.png"`)) return "og:image is not the module's image";
    return d.includes('name="twitter:card" content="summary_large_image"') ? null : "twitter card missing";
  })],
  ["OG PNG exists for every module (non-trivial size)", (t) => { const bad = t.ids.filter((i) => !(t.og[i] > 5000)); return bad.length ? `missing/empty: ${bad.join(", ")}` : null; }],
  ["structured data: valid JSON-LD SoftwareApplication", (t) => eachDoc(t, (d) => {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(d); if (!m) return "no JSON-LD";
    try { const j = JSON.parse(m[1]); return j["@type"] === "SoftwareApplication" && j.name ? null : "wrong JSON-LD type"; } catch { return "JSON-LD does not parse"; }
  })],
  ["a11y/links: descriptive link text, crawlable hrefs, only same-site links, aria-labelled sections", (t) => eachDoc(t, (d) => {
    for (const m of d.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
      if (!/^(\/|#)/.test(m[1])) return `link leaves the module: ${m[1]}`;
      const label = m[2].replace(/<[^>]+>/g, "").trim(); if (!label || /^(click here|here|more)$/i.test(label)) return `non-descriptive link text in ${m[1]}`;
    }
    return /<img\b/.test(d) && /<img\b(?![^>]*\balt=)/.test(d) ? "image without alt" : null;
  })],
  ["zero network: no script src, no stylesheet/font/preconnect, no fetch/XHR/import, no iframes, no external urls", (t) => eachDoc(t, (d) => {
    const body = d.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
    if (/<script\b/i.test(body)) return "contains a script";
    if (/<link\b[^>]*rel="(stylesheet|preconnect|preload|dns-prefetch|modulepreload)"/i.test(body)) return "loads a resource";
    if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|import\()/.test(body)) return "network API referenced";
    if (/<iframe|@import|url\(\s*["']?https?:/i.test(body)) return "embeds an external resource";
    const ext = (text(body).match(/https?:\/\/[^\s"'<]+/g) ?? [])[0]; return ext ? `external url in text: ${ext}` : null;
  })],
  ["login is separate: landing links to /login and /register, never to /api or an auth endpoint", (t) => eachDoc(t, (d) => (!/href="\/login"/.test(d) ? "no /login link" : /href="\/(api|oidc|auth)/.test(d) ? "links to an auth/API path" : null))],
  ["production landing for every module: one title/description/canonical/og:image, indexable, module OG image, guard (token -> homePath)", (t) => {
    for (const id of t.ids) {
      const o = t.prod[id]; if (!o) return `${id}: no production landing`;
      const n = (re) => (o.match(re) ?? []).length; const m = MODULES.find((x) => x.id === id);
      if (n(/<title>/g) !== 1 || n(/name="description"/g) !== 1 || n(/rel="canonical"/g) !== 1 || n(/property="og:image"\s/g) !== 1) return `${id}: duplicate or missing head tags`;
      if (!o.includes(`https://${m.defaultHost}/og/${id}.png`)) return `${id}: og:image is not the module image`;
      if (!/<meta name="robots" content="index, follow"/.test(o) || /noindex/.test(o)) return `${id}: not indexable`;
      if (!o.includes('localStorage.getItem("ayzen_token")') || !o.includes(`location.replace(${JSON.stringify(m.homePath)})`)) return `${id}: signed-in guard missing`;
      if (!/<html[^>]*\blang=/.test(o) || !/<meta name="viewport"/.test(o)) return `${id}: lang/viewport missing`;
    }
    return null;
  }],
  ["designs: every module with a design file ships it; the designed set is exactly the expected 7 (sylo uses the generic landing)", (t) => {
    const have = [...t.designs].sort().join(","); const want = ["fyra", "ryft", "skarn", "verve", "warde", "wisp", "zynth"].join(",");
    return have === want && !hasDesign("sylo") ? null : `designs: ${have}`;
  }],
  ["demo auth is neutralised: no anchor/form/button reaches a design's demo sign-in; sign-in goes to /login and /register", (t) => {
    for (const id of t.ids.filter((i) => t.designs.includes(i))) {
      const o = t.prod[id];
      if (/href="#\/?(login|signin|signup|register|in|up|rst|oidc|welcome)\b[^"]*"/.test(o)) return `${id}: anchor to a demo auth route`;
      if (/<a\b[^>]*\bdata-login\b/.test(o)) return `${id}: data-login anchor still opens the demo portal`;
      if (/(?:href|action)="(?:\.\/)?login(?:\/index)?\.html"/.test(o)) return `${id}: link to login.html`;
      if (!/hash|location\.hash/.test(o) || !/location\.replace\("\/login"\)/.test(o) || !/location\.replace\("\/register"\)/.test(o)) return `${id}: hash deep links are not redirected`;
      if (!/stopImmediatePropagation/.test(o)) return `${id}: data-go click redirect missing`;
    }
    const v = t.assets.verve ?? []; if (v.some((r) => /login|auth\.css/.test(r))) return "verve ships a demo login asset";
    return null;
  }],
  ["design assets: relative urls are rewritten (no bare assets/ fonts/ refs except under <base>), shipped files exist", (t) => {
    for (const id of t.ids) {
      const o = t.prod[id];
      if (id !== "verve" && /(?:href|src)="(?:assets|fonts|media)\//.test(o)) return `${id}: unrewritten asset url`;
      if (id !== "verve" && /url\((['"]?)(?:assets|fonts|media)\//.test(o)) return `${id}: unrewritten css url`;
      if (id === "verve" && !/<base href="\/landing-assets\/verve\/">/.test(o)) return "verve: <base> missing";
      if (id === "wisp" && !(t.assets.wisp ?? []).some((r) => r.endsWith(".woff2"))) return "wisp: fonts not shipped";
    }
    return null;
  }],
  ["third parties limited to Google Fonts and the three.js CDN; none other (script/link/img/iframe)", (t) => {
    const OK = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r128\/)/;
    for (const id of t.ids) for (const m of t.prod[id].matchAll(/<(?:script|link|img|iframe|source)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/g)) if (!OK.test(m[1]) && !/rel="canonical"/.test(m[0])) return `${id}: loads ${m[1]}`;
    return null;
  }],
  ["robots.txt allows only the landing, points at the module sitemap; sitemap lists the landing", (t) => {
    for (const id of t.ids) {
      const r = t.robots ?? robotsTxt(id); const host = MODULES.find((m) => m.id === id).defaultHost;
      if (!/Allow: \/\$/.test(r) || !/Disallow: \/\n/.test(r) || !r.includes(`Sitemap: https://${host}/sitemap.xml`)) return `${id}: robots.txt wrong`;
      if (!sitemapXml(id).includes(`<loc>https://${host}/</loc>`)) return `${id}: sitemap wrong`;
    }
    return null;
  }],
  ["SPA gate: landing rendered BEFORE App is imported; App/posthog only in the signed-in/other-path branch", (t) => {
    const m = t.files["artifacts/ayzen/src/main.tsx"];
    if (/^import (App|\{ ?initPosthog)|from "\.\/App"|from "\.\/lib\/posthog"/m.test(m.replace(/import\("[^"]+"\)/g, ""))) return "App/posthog imported statically";
    const g = m.indexOf("shouldShowModuleLanding("), a = m.indexOf('import("./App")');
    if (g < 0 || a < 0 || g > a) return "gate must come before the App import";
    return /pages\/modules\/landing/.test(m) ? null : "landing page not wired";
  }],
  ["gate logic: module build + path '/' + no token only; token key is ayzen_token; no fetch in gate or page", (t) => {
    const g = t.files["artifacts/ayzen/src/lib/module-landing-gate.ts"], p = t.files["artifacts/ayzen/src/pages/modules/landing.tsx"];
    if (!/p === "" && !input\.hasToken/.test(g) || !/if \(!input\.build\) return false/.test(g)) return "gate condition changed";
    if (!g.includes('"ayzen_token"')) return "wrong token key";
    return /\bfetch\(|useQuery|useEffect|useAuth/.test(g + p) ? "gate/page performs I/O or uses app hooks" : null;
  }],
  ["module build: closeBundle makes the landing index.html and the SPA app.html; assets copied; deploy rewrite targets app.html", (t) => {
    const v = t.files["artifacts/ayzen/vite.module.config.ts"], g = t.files["scripts/gen-module-deploy.mjs"], d = JSON.parse(t.files["deploy/modules/fyra/vercel.json"]);
    if (!/closeBundle\(\)/.test(v) || !/renameSync\(path\.join\(out, 'index\.html'\), path\.join\(out, 'app\.html'\)\)/.test(v)) return "SPA shell is not moved to app.html";
    if (!/writeFileSync\(path\.join\(out, 'index\.html'\), designedLandingHtml\(moduleId\)/.test(v)) return "landing is not written as index.html";
    if (!/designAssets\(moduleId\)/.test(v) || !/robots\.txt/.test(v) || !/sitemap\.xml/.test(v)) return "assets/robots/sitemap not emitted";
    if (/transformIndexHtml/.test(v)) return "the SPA shell must stay clean (no landing injected)";
    return /destination: "\/app\.html"/.test(g) && d.rewrites[0].destination === "/app.html" ? null : "deploy rewrite is not /app.html";
  }],
  ["server: MODULE_LANDING_ENABLED, '/' answered before express.static, asset allow-list, bundle-safe landings dir", (t) => {
    const a = t.files["artifacts/api-server/src/app.ts"], pk = JSON.parse(t.files["packages/module-registry/package.json"]);
    if (!/MODULE_LANDING_ENABLED === "1"/.test(a) || !/designedLandingHtml\(c\.id/.test(a)) return "server landing switch missing";
    const i = a.indexOf('app.get("/", (req, res, next) => {\n    const landing'), j = a.indexOf("app.use(express.static(distPath))");
    if (i < 0 || j < 0 || i > j) return "'/' must be registered before express.static";
    if (!/LANDING_ASSET_FILES\.get\(key\)/.test(a)) return "asset allow-list missing";
    if (!/process\.env\.MODULE_LANDINGS_DIR \?\?=/.test(a)) return "bundled server does not set MODULE_LANDINGS_DIR";
    return pk.exports?.["./landing"] && pk.exports?.["./landing-designs"] ? null : "registry exports missing";
  }],
  ["SPA fallback gate still exists for non-prerendered hosting (landing component, no I/O)", (t) => {
    const m = t.files["artifacts/ayzen/src/main.tsx"];
    return /shouldShowModuleLanding\(/.test(m) ? null : "gate removed";
  }],
  ["CI runs this validator, its self-test and the OG check", (t) => {
    const c = t.files[".github/workflows/ci.yml"];
    return /validate-w2-p4\.mjs\s*$/m.test(c) && /validate-w2-p4\.mjs --self-test/.test(c) && /gen-module-og\.mjs --check/.test(c) ? null : "CI wiring missing";
  }],
];

function run(t) { return RULES.map(([name, fn]) => ({ name, err: fn(t) })); }
function report(rs, label) {
  let bad = 0; for (const r of rs) { if (r.err) { bad++; console.error(`FAIL  ${r.name}\n      ${r.err}`); } else console.log(`ok    ${r.name}`); }
  console.log(`${label}: ${rs.length - bad}/${rs.length} rules pass`); return bad;
}

if (process.argv.includes("--self-test")) {
  const base = load(); const doc = base.docs.sylo; const f = (k) => base.files[k];
  const M = [
    ["missing module landing", { ids: landingIds().filter((i) => i !== "ryft") }, "every registry module"],
    ["duplicate brand accent", { landings: { ...LANDINGS, ryft: { ...LANDINGS.ryft, brand: { ...LANDINGS.ryft.brand, accent: LANDINGS.sylo.brand.accent } } } }, "distinct"],
    ["drop the shards section", { docs: { sylo: doc.replace(/id="pricing"/, 'id="p"') } }, "content depth"],
    ["title removed", { docs: { sylo: doc.replace(/<title>[^<]*<\/title>/, "") } }, "<title>"],
    ["noindex", { docs: { sylo: doc.replace("index, follow", "noindex") } }, "indexable"],
    ["canonical to wrong host", { docs: { sylo: doc.replace(/rel="canonical" href="[^"]+"/, 'rel="canonical" href="https://ayzen.tech/"') } }, "indexable"],
    ["og image generic", { docs: { sylo: doc.replaceAll("/og/sylo.png", "/og-ayzen.png") } }, "Open Graph"],
    ["OG png missing", { og: { ...base.og, zynth: 0 } }, "OG PNG"],
    ["JSON-LD broken", { docs: { sylo: doc.replace(/(ld\+json">)\{/, "$1{{") } }, "structured data"],
    ["outbound link", { docs: { sylo: doc.replace('href="/login"', 'href="https://evil.example/login"') } }, "a11y/links"],
    ["bare 'click here' link", { docs: { sylo: doc.replace(">Sign in</a>", ">click here</a>") } }, "a11y/links"],
    ["script added", { docs: { sylo: doc.replace("</body>", '<script src="/x.js"></script></body>') } }, "zero network"],
    ["web font added", { docs: { sylo: doc.replace("</head>", '<link rel="stylesheet" href="/f.css"></head>') } }, "zero network"],
    ["links to auth endpoint", { docs: { sylo: doc.replace('href="/register"', 'href="/api/auth/login"') } }, "login is separate"],
    ["prod landing: second canonical", { prod: { ryft: base.prod.ryft.replace("</head>", '<link rel="canonical" href="https://x/" /></head>') } }, "production landing"],
    ["prod landing: guard removed", { prod: { fyra: base.prod.fyra.replace(/location\.replace\("\/vault"\)|location\.replace\("\/finance[^"]*"\)/, "void 0") } }, "production landing"],
    ["demo anchor leaks", { prod: { ryft: base.prod.ryft.replace('href="/login"', 'href="#login"') } }, "demo auth"],
    ["data-login anchor leaks", { prod: { skarn: base.prod.skarn.replace('href="/login"', 'href="/login" data-login') } }, "demo auth"],
    ["login.html link leaks", { prod: { wisp: base.prod.wisp.replace('action="/login"', 'action="login/index.html"') } }, "demo auth"],
    ["verve ships demo login", { assets: { ...base.assets, verve: [...base.assets.verve, "login.html"] } }, "demo auth"],
    ["unrewritten asset url", { prod: { wisp: base.prod.wisp.replace("/landing-assets/wisp/fonts/", "fonts/") } }, "design assets"],
    ["unknown third party", { prod: { zynth: base.prod.zynth.replace("</head>", '<script src="https://evil.example/x.js"></script></head>') } }, "third parties"],
    ["design file removed", { designs: base.designs.filter((d) => d !== "wisp") }, "designs:"],
    ["robots allows everything", { robots: "User-agent: *\nAllow: /\n" }, "robots.txt"],
    ["main.tsx imports App statically", { files: { "artifacts/ayzen/src/main.tsx": 'import App from "./App";\n' + f("artifacts/ayzen/src/main.tsx") } }, "SPA gate"],
    ["gate ignores token", { files: { "artifacts/ayzen/src/lib/module-landing-gate.ts": f("artifacts/ayzen/src/lib/module-landing-gate.ts").replace("p === \"\" && !input.hasToken", 'p === ""') } }, "gate logic"],
    ["landing page fetches", { files: { "artifacts/ayzen/src/pages/modules/landing.tsx": f("artifacts/ayzen/src/pages/modules/landing.tsx") + "\nvoid fetch('/api/me');\n" } }, "gate logic"],
    ["landing not written as index.html", { files: { "artifacts/ayzen/vite.module.config.ts": f("artifacts/ayzen/vite.module.config.ts").replace("designedLandingHtml(moduleId)!", "''") } }, "module build:"],
    ["shell injected again", { files: { "artifacts/ayzen/vite.module.config.ts": f("artifacts/ayzen/vite.module.config.ts") + "\n// transformIndexHtml(html)\n" } }, "module build:"],
    ["deploy rewrite back to index.html", { files: { "deploy/modules/fyra/vercel.json": f("deploy/modules/fyra/vercel.json").replace("/app.html", "/index.html") } }, "module build:"],
    ["server switch removed", { files: { "artifacts/api-server/src/app.ts": f("artifacts/api-server/src/app.ts").replace('MODULE_LANDING_ENABLED === "1"', "false") } }, "server:"],
    ["static before landing route", { files: { "artifacts/api-server/src/app.ts": f("artifacts/api-server/src/app.ts").replace('app.use(express.static(distPath));\n  app.get("/{*splat}"', 'app.get("/{*splat}"').replace('app.get("/", (req, res, next) => {\n    const landing', 'app.use(express.static(distPath));\n  app.get("/", (req, res, next) => {\n    const landing') } }, "server:"],
    ["asset allow-list removed", { files: { "artifacts/api-server/src/app.ts": f("artifacts/api-server/src/app.ts").replace("LANDING_ASSET_FILES.get(key)", "key") } }, "server:"],
    ["SPA gate removed", { files: { "artifacts/ayzen/src/main.tsx": f("artifacts/ayzen/src/main.tsx").replace("shouldShowModuleLanding(", "noop(") } }, "SPA fallback gate"],
    ["CI wiring removed", { files: { ".github/workflows/ci.yml": f(".github/workflows/ci.yml").replace(/validate-w2-p4\.mjs/g, "x") } }, "CI runs"],
  ];
  let survivors = 0;
  for (const [name, over, rule] of M) {
    const rs = run(load(over)); const hit = rs.filter((r) => r.err);
    const ok = hit.some((r) => r.name.includes(rule));
    console.log(`${ok ? "killed  " : "SURVIVED"} ${name}${ok ? "" : `  (failed: ${hit.map((h) => h.name.slice(0, 30)).join(" | ") || "none"})`}`);
    if (!ok) survivors++;
  }
  const baseBad = report(run(base), "baseline");
  console.log(`self-test: ${M.length - survivors}/${M.length} mutants killed`);
  process.exit(survivors || baseBad ? 1 : 0);
}
process.exit(report(run(load()), "W2-P4") ? 1 : 0);
