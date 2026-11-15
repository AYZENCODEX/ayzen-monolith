#!/usr/bin/env node
/**
 * gen-central-seo.mjs — W2-P4 follow-up: SEO / sharing / AI files for the CENTRAL host (ayzen.tech), generated so the module
 * list never drifts from the registry.
 *   node scripts/gen-central-seo.mjs            # write public/robots.txt, sitemap.xml, llms.txt and the /landing/ head tags
 *   node scripts/gen-central-seo.mjs --check    # fail if anything is stale (CI)
 *   node scripts/gen-central-seo.mjs --self-test
 * Central URLs only: a sitemap may not list another host's URLs, so each module host serves its own sitemap/robots/llms.txt
 * (landing.mjs); llms.txt here links to every module host instead.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES } from "../packages/module-registry/src/index.mjs";
import { AI_CRAWLERS, getLandingContent, moduleMarkdown } from "../packages/module-registry/src/landing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = "artifacts/ayzen/public";
export const ORIGIN = "https://ayzen.tech";
const TITLE = "AYZEN — the Web3 workspace for airdrop teams and crypto builders";
const DESC = "AYZEN is a Web3 workspace of 8 connected modules for airdrop teams and crypto builders: vault, wallets, finance, marketplace, airdrops, teams, mail and an AI assistant.";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function robots() {
  const rules = `Allow: /\nDisallow: /api/\nDisallow: /oidc/\nDisallow: /auth/\nDisallow: /admin\n`;
  return `# AYZEN (central host). Public pages are open to search engines and AI search/answer crawlers. Each module host serves its own robots.txt, sitemap.xml, llms.txt and llms-full.txt.
User-agent: *
${rules}
${AI_CRAWLERS.map((u) => `User-agent: ${u}`).join("\n")}
${rules}
Sitemap: ${ORIGIN}/sitemap.xml
`;
}
export function sitemap() {
  const urls = ["/", "/landing/", "/login", "/register"];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}\n</urlset>\n`;
}
export function llms(modules = MODULES) {
  return `# AYZEN

> ${DESC}

AYZEN runs as separate modules, each with its own account, session and data. Nothing is shared between modules unless the person connects them. Each module host publishes its own llms.txt and llms-full.txt.

## Modules

${modules.map((m) => { const c = getLandingContent(m.id); return `- [${m.label}](https://${m.defaultHost}/): ${c.summary} (details: https://${m.defaultHost}/about, full text: https://${m.defaultHost}/llms-full.txt)`; }).join("\n")}

## Pages

- [AYZEN overview](${ORIGIN}/landing/): what AYZEN is
- [Full text for AI assistants](${ORIGIN}/llms-full.txt): every module described in one markdown file
- [Sign in](${ORIGIN}/login): sign in with your AYZEN account
- [Create account](${ORIGIN}/register): create an AYZEN account

## Pricing

Prices are not listed here. Anything that costs money is shown inside the product before you confirm it.
`;
}
export function llmsFull(modules = MODULES) {
  return `# AYZEN: full text

> ${DESC}

AYZEN is a Web3 workspace made of ${modules.length} modules. Each module has its own account, session and data; nothing is shared between modules unless the person connects them. Sign in at ${ORIGIN}/login. Each module also publishes its own site, llms.txt and llms-full.txt.

${modules.map((m) => moduleMarkdown(m.id, {}, 2)).join("\n")}
`;
}
export function landingHead() {
  const ld = { "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", name: "AYZEN", url: `${ORIGIN}/`, logo: `${ORIGIN}/favicon.svg`, sameAs: [] },
    { "@type": "WebSite", name: "AYZEN", url: `${ORIGIN}/` } ] };
  return `<!--central-seo:start-->
  <link rel="canonical" href="${ORIGIN}/landing/" />
  <meta name="robots" content="index, follow" />
  <meta property="og:type" content="website" /><meta property="og:site_name" content="AYZEN" /><meta property="og:title" content="${esc(TITLE)}" />
  <meta property="og:description" content="${esc(DESC)}" /><meta property="og:url" content="${ORIGIN}/landing/" /><meta property="og:image" content="${ORIGIN}/og-ayzen.png" />
  <meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(TITLE)}" /><meta name="twitter:description" content="${esc(DESC)}" /><meta name="twitter:image" content="${ORIGIN}/og-ayzen.png" />
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
  <!--central-seo:end-->`;
}
export function applyLanding(html) {
  const stripped = html.replace(/\s*<!--central-seo:start-->[\s\S]*?<!--central-seo:end-->/, "")
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(TITLE)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(DESC)}" />`);
  return stripped.replace("</head>", `  ${landingHead()}\n</head>`);
}

const files = () => ({ [`${PUB}/robots.txt`]: robots(), [`${PUB}/sitemap.xml`]: sitemap(), [`${PUB}/llms.txt`]: llms(), [`${PUB}/llms-full.txt`]: llmsFull(), [`${PUB}/landing/index.html`]: applyLanding(readFileSync(join(ROOT, PUB, "landing/index.html"), "utf8")) });

function problems(cur) {
  const out = [];
  const want = { [`${PUB}/robots.txt`]: robots(), [`${PUB}/sitemap.xml`]: sitemap(), [`${PUB}/llms.txt`]: llms(), [`${PUB}/llms-full.txt`]: llmsFull() };
  for (const [f, w] of Object.entries(want)) if (cur[f] !== w) out.push(`${f} is stale or missing`);
  const l = cur[`${PUB}/landing/index.html`] ?? "";
  if (applyLanding(l) !== l) out.push(`${PUB}/landing/index.html head tags are stale`);
  if (!/<link rel="canonical" href="https:\/\/ayzen\.tech\/landing\/"/.test(l)) out.push("landing: canonical missing");
  if (!/property="og:image" content="https:\/\/ayzen\.tech\/og-ayzen\.png"/.test(l) || !/name="twitter:card"/.test(l)) out.push("landing: OG/Twitter missing");
  if (!existsSync(join(ROOT, PUB, "og-ayzen.png"))) out.push("og-ayzen.png missing");
  const llm = cur[`${PUB}/llms.txt`] ?? "", full = cur[`${PUB}/llms-full.txt`] ?? "";
  for (const m of MODULES) { if (!llm.includes(`https://${m.defaultHost}/about`)) out.push(`llms.txt misses ${m.id}`); if (!full.includes(`https://${m.defaultHost}/`) || !full.includes(getLandingContent(m.id).faq[0][0])) out.push(`llms-full.txt misses ${m.id}`); }
  if (!/GPTBot/.test(cur[`${PUB}/robots.txt`] ?? "") || !/ClaudeBot/.test(cur[`${PUB}/robots.txt`] ?? "")) out.push("robots.txt does not name the AI crawlers");
  if (/Disallow: \/\s*$/m.test(cur[`${PUB}/robots.txt`] ?? "")) out.push("robots.txt disallows the whole site");
  return out;
}
const readCur = () => Object.fromEntries(Object.keys(files()).map((f) => [f, existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : undefined]));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--self-test")) {
    const base = readCur(); let surv = 0;
    const M = [["stale robots", { [`${PUB}/robots.txt`]: "User-agent: *\nAllow: /\n" }], ["no sitemap", { [`${PUB}/sitemap.xml`]: undefined }],
      ["llms drops a module", { [`${PUB}/llms.txt`]: base[`${PUB}/llms.txt`].replace(/- \[Zynth\][^\n]*\n/, "") }],
      ["landing loses canonical", { [`${PUB}/landing/index.html`]: base[`${PUB}/landing/index.html`].replace(/<link rel="canonical"[^>]*>/, "") }],
      ["whole site disallowed", { [`${PUB}/robots.txt`]: robots().replace("Disallow: /api/", "Disallow: /") }]];
    for (const [n, over] of M) { const p = problems({ ...base, ...over }); console.log(`${p.length ? "killed  " : "SURVIVED"} ${n}`); if (!p.length) surv++; }
    const b = problems(base); console.log(b.length ? `baseline FAIL: ${b.join("; ")}` : "baseline ok");
    process.exit(surv || b.length ? 1 : 0);
  } else if (process.argv.includes("--check")) {
    const p = problems(readCur()); if (p.length) { console.error("CENTRAL_SEO: STALE (run node scripts/gen-central-seo.mjs)\n - " + p.join("\n - ")); process.exit(1); }
    console.log("CENTRAL_SEO: PASS");
  } else { for (const [f, c] of Object.entries(files())) writeFileSync(join(ROOT, f), c); console.log("wrote central SEO files"); }
}
