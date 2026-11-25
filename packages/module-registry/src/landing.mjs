/**
 * landing.mjs — W2-P4 (req 11): one public landing per module, data-driven. Pure and dependency-free, so the SAME code
 * renders the page in four places: the module build (prerendered into index.html), the Express app (module host "/"), the
 * SPA gate (when the HTML was not prerendered) and the SEO/network tests. Copy and brand tokens live in LANDINGS below.
 *
 * Deliberately a static page: semantic HTML + a few lines of inline CSS (brand tokens), native <details> for the FAQ, no
 * script, no web fonts, no network request of any kind, so it never touches the API and scores well on SEO/performance.
 * Links stay inside the module (no outbound links to other modules or hosts).
 */
import { getModule } from "./index.mjs";

import { CONTENT } from "./landing-content.mjs";
import { publicPaths, publicSitemapUrls, publicFiles, publicDocument, findPublicPage } from "./sylo-public.mjs";
import { hasDocs, docsSitemapUrls, docsLlmsLinks, docsMarkdown, docsDocument, docsFiles, docsPaths, findDocsPage } from "./sylo-docs.mjs";

/** Public documentation pages (currently Sylo only): /docs, /docs/<chapter>, /docs/<chapter>/<topic>. */
export { publicPaths, publicFiles, publicDocument, findPublicPage };
export { hasDocs, docsDocument, docsFiles, docsPaths, findDocsPage };

/** Copy, brand tokens and facts per module live in landing-content.mjs (grounded in the supplied designs). */
export const LANDINGS = CONTENT;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** @returns the full content set for a module (registry facts + copy + brand), or null. */
export function getLandingContent(id) {
  const m = getModule(id);
  const l = LANDINGS[id];
  if (!m || !l) return null;
  return { id, label: m.label, host: m.defaultHost, homePath: m.homePath, ...l };
}

export const landingIds = () => Object.keys(LANDINGS);

export function landingStyles(c) {
  const b = c.brand;
  return `:root{--bg:${b.bg};--surface:${b.surface};--fg:${b.fg};--muted:${b.muted};--accent:${b.accent};--ink:${b.ink};color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ml a{color:inherit}.ml-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:16px clamp(16px,5vw,48px)}
.ml-brand{font-weight:700;font-size:1.25rem;text-decoration:none;color:var(--accent)}.ml-h nav{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.ml-h nav a{padding:10px 12px;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;color:var(--muted)}.ml-h nav a:hover,.ml-h nav a:focus-visible{color:var(--fg)}
.ml-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 22px;border-radius:12px;background:var(--accent);color:var(--ink)!important;font-weight:700;text-decoration:none;border:2px solid var(--accent)}
.ml-btn.ml-ghost{background:transparent;color:var(--fg)!important;border-color:var(--muted)}.ml a:focus-visible,.ml summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.ml main{max-width:1080px;margin:0 auto;padding:0 clamp(16px,5vw,48px)}.ml section{padding:clamp(32px,7vw,72px) 0}
.ml-hero{padding-top:clamp(24px,6vw,64px)!important}.ml-eyebrow{margin:0 0 12px;color:var(--accent);font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:.85rem}
.ml h1{margin:0 0 16px;font-size:clamp(2rem,6vw,3.5rem);line-height:1.1}.ml h2{margin:0 0 24px;font-size:clamp(1.5rem,4vw,2.25rem)}.ml h3{margin:0 0 8px;font-size:1.1rem}
.ml-lead{max-width:60ch;font-size:1.15rem;color:var(--muted);margin:0 0 28px}.ml-cta{display:flex;flex-wrap:wrap;gap:12px}
.ml-grid{list-style:none;margin:0;padding:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.ml-grid li{background:var(--surface);border-radius:16px;padding:20px;border:1px solid color-mix(in srgb,var(--accent) 25%,transparent)}
.ml-grid p{margin:0;color:var(--muted)}.ml-price{background:var(--surface);border-radius:20px;padding:clamp(20px,5vw,40px);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}.ml-price p{max-width:60ch;color:var(--muted);margin:0 0 20px}
.ml details{background:var(--surface);border-radius:12px;margin:0 0 12px;padding:4px 16px}.ml summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}.ml details p{margin:0 0 14px;color:var(--muted)}
.ml-f{display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between;padding:24px clamp(16px,5vw,48px) 40px;color:var(--muted);border-top:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}.ml-f nav{display:flex;flex-wrap:wrap;gap:4px 8px}.ml-f a{padding:10px 8px;min-height:44px;display:inline-flex;align-items:center}`;
}

/** The page body (header, main, footer) as an HTML string. */
export function landingBody(c) {
  const L = esc(c.label);
  return `<div class="ml" data-module-landing="${esc(c.id)}">
<header class="ml-h"><a class="ml-brand" href="/" aria-label="${L} home">${L}</a><nav aria-label="Primary"><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a><a href="/about">About</a><a href="/login">Sign in to ${L}</a></nav></header>
<main>
<section class="ml-hero" aria-labelledby="ml-h1"><p class="ml-eyebrow">${esc(c.hero.eyebrow)}</p><h1 id="ml-h1">${esc(c.hero.title)}</h1><p class="ml-lead">${esc(c.hero.lead)}</p><div class="ml-cta"><a class="ml-btn" href="/register">Create your ${L} account</a><a class="ml-btn ml-ghost" href="/login">Sign in</a></div></section>
<section id="features" aria-labelledby="ml-features"><h2 id="ml-features">What you get with ${L}</h2><ul class="ml-grid">${c.features.map((f) => `<li><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></li>`).join("")}</ul></section>
<section id="pricing" aria-labelledby="ml-pricing"><div class="ml-price"><h2 id="ml-pricing">Pricing</h2><p>${esc(c.pricing)}</p><a class="ml-btn" href="/register">Create your ${L} account</a> <a class="ml-btn ml-ghost" href="/about">Read everything about ${L}</a></div></section>
<section id="faq" aria-labelledby="ml-faq"><h2 id="ml-faq">Questions about ${L}</h2>${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
</main>
<footer class="ml-f"><span>&copy; AYZEN. ${L} is a module of AYZEN.</span><nav aria-label="Footer"><a href="/about">About ${L}</a><a href="/login">Sign in</a><a href="/register">Create account</a><a href="/status">Service status</a></nav></footer>
</div>`;
}

const origin = (c, o) => (o ?? `https://${c.host}`).replace(/\/$/, "");

/** Head tags for SEO and sharing (title, description, canonical, robots, Open Graph, Twitter, JSON-LD). */
export function landingHead(c, opts = {}) {
  const base = origin(c, opts.origin);
  const title = `${c.label} — ${c.category} | AYZEN`;
  const desc = c.summary;
  const image = `${base}/og/${c.id}.png`;
  const ld = { "@context": "https://schema.org", "@type": "SoftwareApplication", name: c.label, description: c.summary, applicationCategory: "BusinessApplication", applicationSubCategory: c.category, operatingSystem: "Web", url: `${base}/`, image, featureList: c.features.map((f) => f.title), publisher: { "@type": "Organization", name: "AYZEN", url: "https://ayzen.tech/" }, isPartOf: { "@type": "WebSite", name: "AYZEN", url: "https://ayzen.tech/" } };
  return { title, description: desc, canonical: `${base}/`, image, jsonLd: ld, themeColor: c.brand.bg, base };
}

export function landingHeadHtml(c, opts = {}) {
  const h = landingHead(c, opts);
  return `<title>${esc(h.title)}</title>
<meta name="description" content="${esc(h.description)}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${esc(h.canonical)}" />
<meta name="theme-color" content="${esc(h.themeColor)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="${esc(c.label)}" /><meta property="og:title" content="${esc(h.title)}" />
<meta property="og:description" content="${esc(h.description)}" /><meta property="og:url" content="${esc(h.canonical)}" /><meta property="og:image" content="${esc(h.image)}" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:alt" content="${esc(c.label)} — ${esc(c.tagline)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(h.title)}" /><meta name="twitter:description" content="${esc(h.description)}" /><meta name="twitter:image" content="${esc(h.image)}" />
<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>
<style id="module-landing-css">${landingStyles(c)}</style>`;
}

/** A complete standalone document (used by tests, and as the static fallback for hosts that serve no SPA). */
export function landingDocument(c, opts = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${landingHeadHtml(c, opts)}
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body>
${landingBody(c)}
</body>
</html>
`;
}

/**
 * Put the landing into the SPA shell (index.html): module head tags replace the generic ones, the prerendered body goes inside
 * #root, and a tiny inline script removes it again for everything except a signed-out visit to "/" so deep links never flash it.
 */
export function injectLandingIntoHtml(html, id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return html;
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+(?:name|property)="(?:description|robots|og:[^"]*|twitter:[^"]*|theme-color)"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");
  const guard = `<script>(function(){try{var t=localStorage.getItem("ayzen_token")||sessionStorage.getItem("ayzen_token")}catch(e){}if(location.pathname!=="/"||t){var r=document.getElementById("root");if(r)r.textContent=""}})()</script>`;
  return stripped
    .replace("</head>", `${landingHeadHtml(c, opts)}\n</head>`)
    .replace(/<div id="root"><\/div>/, `<div id="root">${landingBody(c)}</div>\n${guard}`);
}

/** AI search / answer / assistant crawlers that are explicitly allowed on the public pages (same rules as everyone else). */
export const AI_CRAWLERS = Object.freeze(["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "Bingbot", "DuckAssistBot", "meta-externalagent", "Amazonbot", "cohere-ai", "MistralAI-User"]);
export const PUBLIC_PATHS = Object.freeze(["/about", "/docs", "/explore", "/llms.txt", "/llms-full.txt"]);

export function robotsTxt(id, opts = {}) {
  const c = getLandingContent(id);
  const base = c ? origin(c, opts.origin) : "";
  const rules = `Allow: /$\nAllow: /about$\n${hasDocs(id) ? "Allow: /docs\nAllow: /explore\n" : ""}Allow: /og/\nAllow: /landing-assets/\nAllow: /llms.txt\nAllow: /llms-full.txt\nDisallow: /\n`;
  return `# ${c ? c.label : "AYZEN module"}: the public pages are open to search engines and AI search/answer crawlers; the signed-in app is not.\nUser-agent: *\n${rules}\n${AI_CRAWLERS.map((u) => `User-agent: ${u}`).join("\n")}\n${rules}${base ? `\nSitemap: ${base}/sitemap.xml\n` : ""}`;
}

export function sitemapXml(id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return "";
  const base = origin(c, opts.origin);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...["/", "/about"].map((u) => `${base}${u}`), ...(hasDocs(id) ? [...docsSitemapUrls(opts), ...publicSitemapUrls(opts)] : [])].map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n")}\n</urlset>\n`;
}

const bullets = (a) => a.map((x) => `- ${x}`).join("\n");
const modName = (id) => getModule(id)?.label ?? id;

/** llms.txt (llmstxt.org format): short, link-first guide for AI crawlers and assistants. */
export function llmsTxt(id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return "";
  const base = origin(c, opts.origin);
  return `# ${c.label}

> ${c.summary}

${c.label} is a module of AYZEN, with its own account, session and data. Category: ${c.category}.

## Pages

- [${c.label} home](${base}/): overview, features and FAQ
- [About ${c.label}](${base}/about): full details, how it works, use cases, limits and FAQ
- [Full text for AI assistants](${base}/llms-full.txt): everything on this site as one markdown file
${hasDocs(id) ? docsLlmsLinks(opts) + "\n" : ""}- [Sign in](${base}/login): sign in to ${c.label}
- [Create account](${base}/register): create a ${c.label} account

## What you get

${bullets(c.features.map((f) => `${f.title}: ${f.text}`))}

## Pricing

${c.pricing}

## FAQ

${bullets(c.faq.map(([q, a]) => `${q} ${a}`))}

## Optional

${bullets(c.related.map((r) => `[${modName(r)}](https://${getModule(r).defaultHost}/): another AYZEN module`))}
`;
}

/** One module as a markdown block (shared by llms-full.txt per module and the central llms-full.txt). */
export function moduleMarkdown(id, opts = {}, level = 1) {
  const c = getLandingContent(id);
  if (!c) return "";
  const base = origin(c, opts.origin);
  const h = (n) => "#".repeat(Math.min(6, level + n));
  return `${h(0)} ${c.label}

> ${c.summary}

URL: ${base}/ · Category: ${c.category} · A module of AYZEN with its own account, session and data.

${c.hero.lead}

${h(1)} Features

${bullets(c.features.map((f) => `**${f.title}.** ${f.text}`))}

${h(1)} In detail

${c.areas.map((a) => `${h(2)} ${a.title}\n\n${a.text}\n\n${bullets(a.items)}`).join("\n\n")}

${h(1)} How it works

${c.steps.map((st, i) => `${i + 1}. **${st.title}.** ${st.text}`).join("\n")}

${h(1)} Use cases

${bullets(c.useCases)}

${h(1)} Limits and honest notes

${bullets(c.limits)}

${h(1)} Pricing

${c.pricing}

${h(1)} FAQ

${c.faq.map(([q, a]) => `**${q}** ${a}`).join("\n\n")}

${h(1)} Related AYZEN modules

${bullets(c.related.map((r) => `[${modName(r)}](https://${getModule(r).defaultHost}/)`))}
`;
}

export function llmsFullTxt(id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return "";
  const base = origin(c, opts.origin);
  return `${moduleMarkdown(id, opts, 1)}
${hasDocs(id) ? docsMarkdown(opts, 1) + "\n" : ""}## Links

- Home: ${base}/
- About: ${base}/about
${hasDocs(id) ? `- Documentation: ${base}/docs\n` : ""}- Sign in: ${base}/login
- Create account: ${base}/register
- Short version: ${base}/llms.txt
`;
}

/** /about: the long-form, server-rendered page for people and for search/AI crawlers (visible FAQ + FAQPage JSON-LD). */
export function aboutHead(c, opts = {}) {
  const base = origin(c, opts.origin);
  const title = `About ${c.label}: features, how it works, FAQ | AYZEN`;
  const desc = `${c.summary} Full feature list, how ${c.label} works, use cases, limits and answers to common questions.`.slice(0, 300);
  const image = `${base}/og/${c.id}.png`;
  const ld = { "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": `${base}/about#page`, url: `${base}/about`, name: title, description: desc, inLanguage: "en", isPartOf: { "@type": "WebSite", name: c.label, url: `${base}/` }, about: { "@id": `${base}/#app` } },
    { "@type": "SoftwareApplication", "@id": `${base}/#app`, name: c.label, description: c.summary, applicationCategory: "BusinessApplication", applicationSubCategory: c.category, operatingSystem: "Web", url: `${base}/`, image, featureList: c.features.map((f) => f.title), publisher: { "@type": "Organization", name: "AYZEN", url: "https://ayzen.tech/" } },
    { "@type": "FAQPage", mainEntity: c.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: c.label, item: `${base}/` }, { "@type": "ListItem", position: 2, name: "About", item: `${base}/about` }] },
  ] };
  return { title, description: desc, canonical: `${base}/about`, image, jsonLd: ld, base };
}

export function aboutBody(c) {
  const L = esc(c.label);
  return `<div class="ml" data-module-about="${esc(c.id)}">
<header class="ml-h"><a class="ml-brand" href="/" aria-label="${L} home">${L}</a><nav aria-label="Primary"><a href="/">Home</a><a href="#features">Features</a><a href="#detail">In detail</a><a href="#faq">FAQ</a>${hasDocs(c.id) ? '<a href="/docs">Docs</a>' : ""}<a href="/login">Sign in</a></nav></header>
<main>
<nav class="ml-crumbs" aria-label="Breadcrumb"><a href="/">${L}</a> / <span aria-current="page">About</span></nav>
<section class="ml-hero" aria-labelledby="ab-h1"><p class="ml-eyebrow">${esc(c.category)}</p><h1 id="ab-h1">About ${L}: ${esc(c.tagline.replace(/\.$/, ""))}</h1><p class="ml-lead">${esc(c.hero.lead)}</p><div class="ml-cta"><a class="ml-btn" href="/register">Create your ${L} account</a><a class="ml-btn ml-ghost" href="/login">Sign in</a></div></section>
<section aria-labelledby="ab-what"><h2 id="ab-what">What is ${L}?</h2><p>${esc(c.summary)} ${L} is one of eight modules of AYZEN. Each module has its own account, session and data, and nothing is shared with other modules unless you connect them.</p></section>
<section id="features" aria-labelledby="ab-features"><h2 id="ab-features">Features</h2><ul class="ml-grid">${c.features.map((f) => `<li><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></li>`).join("")}</ul></section>
<section id="detail" aria-labelledby="ab-detail"><h2 id="ab-detail">${L} in detail</h2>${c.areas.map((a) => `<h3>${esc(a.title)}</h3><p>${esc(a.text)}</p><ul class="ml-list">${a.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("")}</section>
<section aria-labelledby="ab-how"><h2 id="ab-how">How ${L} works</h2><ol class="ml-list">${c.steps.map((st) => `<li><strong>${esc(st.title)}.</strong> ${esc(st.text)}</li>`).join("")}</ol></section>
<section aria-labelledby="ab-use"><h2 id="ab-use">What people use ${L} for</h2><ul class="ml-list">${c.useCases.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></section>
<section aria-labelledby="ab-limits"><h2 id="ab-limits">Limits and honest notes</h2><ul class="ml-list">${c.limits.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></section>
<section aria-labelledby="ab-pricing"><div class="ml-price"><h2 id="ab-pricing">Pricing</h2><p>${esc(c.pricing)}</p></div></section>
<section id="faq" aria-labelledby="ab-faq"><h2 id="ab-faq">Frequently asked questions about ${L}</h2>${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
<section aria-labelledby="ab-rel"><h2 id="ab-rel">Other AYZEN modules</h2><ul class="ml-list">${c.related.map((r) => `<li><a href="https://${esc(getModule(r).defaultHost)}/">${esc(modName(r))}</a></li>`).join("")}</ul><p><a href="https://ayzen.tech/landing/">What is AYZEN?</a></p></section>
</main>
<footer class="ml-f"><span>&copy; AYZEN. ${L} is a module of AYZEN.</span><nav aria-label="Footer"><a href="/">${L} home</a><a href="/login">Sign in</a><a href="/register">Create account</a><a href="/llms.txt">llms.txt</a></nav></footer>
</div>`;
}

export function aboutDocument(c, opts = {}) {
  const h = aboutHead(c, opts);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(h.title)}</title>
<meta name="description" content="${esc(h.description)}" />
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large" />
<link rel="canonical" href="${esc(h.canonical)}" />
<meta name="theme-color" content="${esc(c.brand.bg)}" />
<meta property="og:type" content="article" /><meta property="og:site_name" content="${esc(c.label)}" /><meta property="og:title" content="${esc(h.title)}" />
<meta property="og:description" content="${esc(h.description)}" /><meta property="og:url" content="${esc(h.canonical)}" /><meta property="og:image" content="${esc(h.image)}" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:alt" content="${esc(c.label)} — ${esc(c.tagline)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(h.title)}" /><meta name="twitter:description" content="${esc(h.description)}" /><meta name="twitter:image" content="${esc(h.image)}" />
<link rel="alternate" type="text/markdown" href="${esc(h.base)}/llms-full.txt" title="${esc(c.label)} for AI assistants" />
<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>
<style>${landingStyles(c)}.ml-crumbs{padding:12px 0;color:var(--muted)}.ml-list{padding-left:1.2em;margin:0 0 20px}.ml-list li{margin:6px 0}.ml h3{margin-top:24px}</style>
</head>
<body>
${aboutBody(c)}
</body>
</html>
`;
}
