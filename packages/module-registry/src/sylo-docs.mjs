/**
 * sylo-docs.mjs: public, server-rendered documentation for Sylo (the SYLO / AYZEN ecosystem notes).
 * Pure and dependency-free like landing.mjs: the SAME functions render the pages in the Express app (sylo host `/docs...`), in the
 * module build (static files) and in the validators. No script, no web font, no network request.
 *
 * URLs:  /docs                         index (all chapters, topics, subtopics)
 *        /docs/<chapter>               chapter page (its topics)
 *        /docs/<chapter>/<topic>       topic page (every subtopic, every line of the notes)
 * Content: sylo-docs-data.mjs (the notes as written; do not reword). SEO: title, description, canonical, robots,
 * Open Graph/Twitter, TechArticle/CollectionPage + BreadcrumbList JSON-LD, prev/next links, sitemap entries, llms.txt links and
 * the whole text in llms-full.txt, so search engines and AI assistants can read and cite it.
 */
import { SYLO_DOCS } from "./sylo-docs-data.mjs";
import { CONTENT } from "./landing-content.mjs";
import { getModule } from "./index.mjs";

export const DOCS_MODULE = "sylo";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const hasBn = (s) => /[\u0980-\u09FF]/.test(s);
const anchor = (n) => `s-${String(n).replace(/\./g, "-")}`;

const origin = (o) => (o || `https://${getModule(DOCS_MODULE).defaultHost}`).replace(/\/$/, "");
export const hasDocs = (id) => id === DOCS_MODULE;

/** Flat page list: index, every chapter, every topic (in reading order for prev/next). */
export function docsPages() {
  const pages = [{ kind: "index", path: "/docs" }];
  for (const ch of SYLO_DOCS) {
    pages.push({ kind: "chapter", path: `/docs/${ch.slug}`, ch });
    for (const t of ch.topics) pages.push({ kind: "topic", path: `/docs/${ch.slug}/${t.slug}`, ch, t });
  }
  return pages;
}
export const docsPaths = () => docsPages().map((p) => p.path);
export function findDocsPage(pathname) {
  const p = String(pathname).replace(/\/+$/, "") || "/";
  return docsPages().find((x) => x.path === p) || null;
}
const topicPages = () => docsPages().filter((p) => p.kind === "topic");
const nSubs = (t) => t.subs.length;
const nLines = (t) => t.subs.reduce((n, s) => n + s.lines.length, 0);

/* ---------- note lines -> blocks (text is kept exactly; only the checkbox glyph and indentation are dropped) ---------- */
const DIAGRAM = /[→←↔⇒⟶—━─┌└│]|\[|^\s*"|\S {3,}\S|\.{4,}/;
export function lineBlocks(lines) {
  const out = [];
  let pre = null;
  const flush = () => { if (pre) { const min = Math.min(...pre.map((l) => l.match(/^ */)[0].length)); out.push({ t: "pre", text: pre.map((l) => l.slice(min).replace(/\s+$/, "")).join("\n") }); pre = null; } };
  for (const raw of lines) {
    if (!raw.trim()) { flush(); continue; }
    if (raw.trimStart().startsWith("☐")) { flush(); out.push({ t: "p", text: raw.trimStart().slice(1).trim() }); continue; }
    if (!/^\s/.test(raw)) { flush(); out.push({ t: "p", text: raw.trim() }); continue; }
    if (/^\s*(\(?[ivx]+\)|\d+[.)]|-)\s/.test(raw)) { flush(); out.push({ t: "li", text: raw.trim() }); continue; }
    if (DIAGRAM.test(raw)) { (pre ||= []).push(raw); continue; }
    flush(); out.push({ t: "p", text: raw.trim() });
  }
  flush();
  return out;
}
function blocksHtml(lines) {
  const parts = [];
  let li = [];
  const flushLi = () => { if (li.length) { parts.push(`<ul class="dx-items">${li.join("")}</ul>`); li = []; } };
  for (const b of lineBlocks(lines)) {
    const lang = hasBn(b.text) ? ` lang="bn"` : "";
    if (b.t === "li") { li.push(`<li${lang}>${esc(b.text)}</li>`); continue; }
    flushLi();
    parts.push(b.t === "pre" ? `<pre class="dx-diagram"${lang}>${esc(b.text)}</pre>` : `<p${lang}>${esc(b.text)}</p>`);
  }
  flushLi();
  return parts.join("\n");
}

/* ---------- styles / chrome ---------- */
function styles(c) {
  const b = c.brand;
  return `:root{--bg:${b.bg};--surface:${b.surface};--fg:${b.fg};--muted:${b.muted};--accent:${b.accent};--ink:${b.ink};color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali","Hind Siliguri","Nirmala UI",sans-serif}
a{color:var(--accent)}a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.dx-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:14px clamp(16px,4vw,40px);border-bottom:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}
.dx-brand{font-weight:700;font-size:1.2rem;text-decoration:none}.dx-h nav{display:flex;flex-wrap:wrap;gap:4px}.dx-h nav a{padding:10px 12px;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;color:var(--muted)}
.dx-h nav a:hover{color:var(--fg)}
.dx-wrap{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:clamp(20px,4vw,56px);max-width:1240px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
@media(max-width:860px){.dx-wrap{grid-template-columns:1fr}}
.dx-side{padding:28px 0;font-size:.95rem}.dx-side details{margin:0 0 8px}.dx-side summary{cursor:pointer;font-weight:700;min-height:36px;display:flex;align-items:center}
.dx-side ul{list-style:none;margin:0 0 8px;padding:0 0 0 12px}.dx-side li a{display:block;padding:6px 8px;text-decoration:none;color:var(--muted);border-radius:6px}.dx-side li a:hover,.dx-side li a[aria-current=page]{color:var(--fg);background:var(--surface)}
.dx-main{padding:28px 0 64px;min-width:0}.dx-crumbs{color:var(--muted);font-size:.9rem;margin:0 0 20px}.dx-crumbs a{color:var(--muted)}
.dx-eyebrow{margin:0 0 8px;color:var(--accent);font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:.8rem}
h1{margin:0 0 14px;font-size:clamp(1.9rem,5vw,3rem);line-height:1.12}h2{margin:44px 0 12px;font-size:clamp(1.3rem,3.2vw,1.8rem);line-height:1.25;scroll-margin-top:16px}h2 .dx-n{color:var(--accent);margin-right:.5em}
.dx-lead{color:var(--muted);max-width:68ch;margin:0 0 24px}
.dx-note p{margin:0 0 14px;max-width:78ch}.dx-items{margin:0 0 14px;padding:0;list-style:none;max-width:78ch}.dx-items li{margin:6px 0;padding:8px 14px;background:var(--surface);border-left:3px solid var(--accent);border-radius:6px}
.dx-diagram{margin:0 0 16px;padding:14px 16px;background:var(--surface);border:1px solid color-mix(in srgb,var(--muted) 30%,transparent);border-radius:10px;overflow-x:auto;font:.92rem/1.55 ui-monospace,Menlo,Consolas,"Noto Sans Bengali",monospace;white-space:pre}
.dx-grid{list-style:none;margin:0;padding:0;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.dx-grid li{background:var(--surface);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:14px;padding:16px 18px}
.dx-grid h3{margin:0 0 6px;font-size:1.05rem}.dx-grid p{margin:0;color:var(--muted);font-size:.95rem}.dx-grid a{text-decoration:none;color:var(--fg)}
.dx-toc ol{padding-left:1.3em}.dx-toc li{margin:4px 0}
.dx-pn{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;margin:48px 0 0;padding-top:20px;border-top:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}.dx-pn a{display:block;padding:12px 16px;border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:10px;text-decoration:none;min-width:200px}
.dx-pn small{display:block;color:var(--muted)}
.dx-f{padding:24px clamp(16px,4vw,40px) 40px;color:var(--muted);border-top:1px solid color-mix(in srgb,var(--muted) 25%,transparent);display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between}.dx-f a{color:var(--muted)}`;
}

function sidebar(cur) {
  return `<aside class="dx-side" aria-label="Documentation contents"><p class="dx-eyebrow"><a href="/docs" style="text-decoration:none">Sylo documentation</a></p>${SYLO_DOCS.map((ch) =>
    `<details${cur && cur.ch && cur.ch.slug === ch.slug ? " open" : ""}><summary>${ch.n}. ${esc(ch.title)}</summary><ul>${ch.topics.map((t) =>
      `<li><a href="/docs/${ch.slug}/${t.slug}"${cur && cur.t && cur.t.slug === t.slug && cur.ch.slug === ch.slug ? ' aria-current="page"' : ""}>${t.n} ${esc(t.title)}</a></li>`).join("")}</ul></details>`).join("")}</aside>`;
}

function chrome(c, h, bodyHtml, cur) {
  const base = h.base;
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
<meta property="og:description" content="${esc(h.description)}" /><meta property="og:url" content="${esc(h.canonical)}" /><meta property="og:image" content="${esc(base)}/og/${c.id}.png" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(h.title)}" /><meta name="twitter:description" content="${esc(h.description)}" /><meta name="twitter:image" content="${esc(base)}/og/${c.id}.png" />
${h.prev ? `<link rel="prev" href="${esc(base + h.prev)}" />\n` : ""}${h.next ? `<link rel="next" href="${esc(base + h.next)}" />\n` : ""}<link rel="alternate" type="text/markdown" href="${esc(base)}/llms-full.txt" title="${esc(c.label)} for AI assistants" />
<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>
<style>${styles(c)}</style>
</head>
<body>
<header class="dx-h"><a class="dx-brand" href="/" aria-label="${esc(c.label)} home">${esc(c.label)}</a><nav aria-label="Primary"><a href="/">Home</a><a href="/about">About</a><a href="/docs">Docs</a><a href="/login">Sign in</a></nav></header>
<div class="dx-wrap">
${sidebar(cur)}
<main class="dx-main">
${bodyHtml}
</main>
</div>
<footer class="dx-f"><span>&copy; AYZEN. ${esc(c.label)} is a module of AYZEN.</span><nav aria-label="Footer"><a href="/">${esc(c.label)} home</a> · <a href="/about">About</a> · <a href="/docs">Docs</a> · <a href="/llms.txt">llms.txt</a> · <a href="/llms-full.txt">llms-full.txt</a></nav></footer>
</body>
</html>
`;
}

const crumbsHtml = (items) => `<nav class="dx-crumbs" aria-label="Breadcrumb">${items.map(([n, u], i) => (i === items.length - 1 ? `<span aria-current="page">${esc(n)}</span>` : `<a href="${u}">${esc(n)}</a>`)).join(" / ")}</nav>`;
const crumbsLd = (base, items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: base + u })) });
const publisher = { "@type": "Organization", name: "AYZEN", url: "https://ayzen.tech/" };

/** One page of the docs as a full HTML document. */
export function docsDocument(page, opts = {}) {
  const c = { id: DOCS_MODULE, label: getModule(DOCS_MODULE).label, ...CONTENT[DOCS_MODULE] };
  const base = origin(opts.origin);
  const L = c.label;
  const tps = topicPages();
  const ix = tps.findIndex((p) => p.path === page.path);
  const crumbRoot = [[L, "/"], ["Docs", "/docs"]];

  if (page.kind === "index") {
    const title = `${L} documentation: utility and use-cases | AYZEN`;
    const description = `${L} / AYZEN ecosystem notes: the access and entity system, backup, automation, security and login, connected modules and AI, and airdrop, credit, account-resale and platform use-cases.`;
    const nTopics = SYLO_DOCS.reduce((n, ch) => n + ch.topics.length, 0);
    const jsonLd = { "@context": "https://schema.org", "@graph": [
      { "@type": "CollectionPage", "@id": `${base}/docs#page`, url: `${base}/docs`, name: title, description, inLanguage: ["bn", "en"], isPartOf: { "@type": "WebSite", name: L, url: `${base}/` }, publisher,
        mainEntity: { "@type": "ItemList", itemListElement: tps.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: `${p.t.n} ${p.t.title}`, url: base + p.path })) } },
      crumbsLd(base, crumbRoot) ] };
    const body = `${crumbsHtml(crumbRoot)}<p class="dx-eyebrow">Documentation</p><h1>${esc(L)} documentation</h1>
<p class="dx-lead">${esc(L)} / AYZEN ecosystem notes in ${SYLO_DOCS.length} chapters, ${nTopics} topics and ${tps.reduce((n, p) => n + nSubs(p.t), 0)} subtopics: what ${esc(L)} does, how access, entities, backup and security work, and how it is used for airdrop farming, credits and account resale. The notes are mixed Bengali and English and are published as written.</p>
${SYLO_DOCS.map((ch) => `<section aria-labelledby="c-${ch.slug}"><h2 id="c-${ch.slug}"><span class="dx-n">${ch.n}</span><a href="/docs/${ch.slug}" style="color:inherit;text-decoration:none">${esc(ch.title)}</a></h2><p class="dx-lead" lang="bn">${esc(ch.desc)}</p>
<ul class="dx-grid">${ch.topics.map((t) => `<li><h3><a href="/docs/${ch.slug}/${t.slug}">${t.n} ${esc(t.title)}</a></h3><p>${t.subs.map((s) => `${s.n} ${esc(s.title)}`).join(" · ")}</p></li>`).join("")}</ul></section>`).join("\n")}`;
    return chrome(c, { base, title, description, canonical: `${base}/docs`, jsonLd, next: tps[0].path }, body, {});
  }

  if (page.kind === "chapter") {
    const ch = page.ch;
    const title = `${ch.title}: ${ch.topics.map((t) => t.title).join(", ")} | ${L} documentation`.slice(0, 160);
    const description = `${L} documentation, chapter ${ch.n} ${ch.title}: ${ch.desc}. Topics: ${ch.topics.map((t) => t.title).join(", ")}.`.slice(0, 300);
    const crumbs = [...crumbRoot, [`${ch.n}. ${ch.title}`, page.path]];
    const jsonLd = { "@context": "https://schema.org", "@graph": [
      { "@type": "CollectionPage", "@id": `${base}${page.path}#page`, url: base + page.path, name: title, description, inLanguage: ["bn", "en"], isPartOf: { "@type": "WebSite", name: L, url: `${base}/` }, publisher,
        mainEntity: { "@type": "ItemList", itemListElement: ch.topics.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: `${t.n} ${t.title}`, url: `${base}/docs/${ch.slug}/${t.slug}` })) } },
      crumbsLd(base, crumbs) ] };
    const body = `${crumbsHtml(crumbs)}<p class="dx-eyebrow">Chapter ${ch.n}</p><h1>${esc(ch.title)}</h1><p class="dx-lead" lang="bn">${esc(ch.desc)}</p>
<ul class="dx-grid">${ch.topics.map((t) => `<li><h3><a href="/docs/${ch.slug}/${t.slug}">${t.n} ${esc(t.title)}</a></h3><p>${t.subs.map((s) => `${s.n} ${esc(s.title)}`).join(" · ")}</p></li>`).join("")}</ul>`;
    const ci = SYLO_DOCS.findIndex((x) => x.slug === ch.slug);
    const prev = SYLO_DOCS[ci - 1], next = SYLO_DOCS[ci + 1];
    return chrome(c, { base, title, description, canonical: base + page.path, jsonLd, prev: prev ? `/docs/${prev.slug}` : "/docs", next: next ? `/docs/${next.slug}` : null },
      body + `<div class="dx-pn">${prev ? `<a href="/docs/${prev.slug}" rel="prev"><small>Previous chapter</small>${prev.n}. ${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a href="/docs/${next.slug}" rel="next"><small>Next chapter</small>${next.n}. ${esc(next.title)}</a>` : ""}</div>`, { ch });
  }

  // topic
  const { ch, t } = page;
  const heads = t.subs.map((s) => s.title).join(", ");
  const title = `${t.title}: ${heads === t.title ? `${L} documentation` : heads} | ${L} ${ch.title}`.slice(0, 160);
  const firstText = lineBlocks(t.subs.flatMap((s) => s.lines)).find((b) => b.t === "p");
  const description = `${L} documentation ${t.n} ${t.title} (${ch.title}). ${t.subs.map((s) => s.title).join(", ")}.${firstText ? " " + firstText.text : ""}`.replace(/\s+/g, " ").slice(0, 300);
  const crumbs = [...crumbRoot, [`${ch.n}. ${ch.title}`, `/docs/${ch.slug}`], [`${t.n} ${t.title}`, page.path]];
  const prevP = tps[ix - 1], nextP = tps[ix + 1];
  const jsonLd = { "@context": "https://schema.org", "@graph": [
    { "@type": "TechArticle", "@id": `${base}${page.path}#article`, url: base + page.path, headline: `${t.n} ${t.title}`, name: title, description, inLanguage: ["bn", "en"], articleSection: ch.title, about: { "@id": `${base}/#app` },
      isPartOf: { "@type": "CollectionPage", url: `${base}/docs/${ch.slug}`, name: ch.title }, mainEntityOfPage: base + page.path, image: `${base}/og/${DOCS_MODULE}.png`, publisher, author: publisher,
      hasPart: t.subs.map((s) => ({ "@type": "WebPageElement", name: `${s.n} ${s.title}`, url: `${base}${page.path}#${anchor(s.n)}` })) },
    crumbsLd(base, crumbs) ] };
  const body = `${crumbsHtml(crumbs)}<p class="dx-eyebrow">Chapter ${ch.n} · ${esc(ch.title)}</p><h1>${t.n} ${esc(t.title)}</h1>
<nav class="dx-toc" aria-label="On this page"><ol>${t.subs.map((s) => `<li><a href="#${anchor(s.n)}">${s.n} ${esc(s.title)}</a></li>`).join("")}</ol></nav>
${t.subs.map((s) => `<section aria-labelledby="h-${anchor(s.n)}" id="${anchor(s.n)}"><h2 id="h-${anchor(s.n)}"><span class="dx-n">${s.n}</span>${esc(s.title)}</h2><div class="dx-note">${blocksHtml(s.lines)}</div></section>`).join("\n")}
<div class="dx-pn">${prevP ? `<a href="${prevP.path}" rel="prev"><small>Previous</small>${prevP.t.n} ${esc(prevP.t.title)}</a>` : "<span></span>"}${nextP ? `<a href="${nextP.path}" rel="next"><small>Next</small>${nextP.t.n} ${esc(nextP.t.title)}</a>` : ""}</div>`;
  return chrome(c, { base, title, description, canonical: base + page.path, jsonLd, prev: prevP?.path, next: nextP?.path }, body, { ch, t });
}

/* ---------- sitemap / llms ---------- */
export const docsSitemapUrls = (opts = {}) => docsPaths().map((p) => `${origin(opts.origin)}${p}`);

export function docsLlmsLinks(opts = {}) {
  const base = origin(opts.origin);
  return [`- [Sylo documentation](${base}/docs): the full SYLO / AYZEN ecosystem notes, ${SYLO_DOCS.length} chapters`,
    ...SYLO_DOCS.map((ch) => `- [${ch.n}. ${ch.title}](${base}/docs/${ch.slug}): ${ch.desc}`)].join("\n");
}

/** The whole documentation as one markdown block (for llms-full.txt). Note lines are copied unchanged. */
export function docsMarkdown(opts = {}, level = 2) {
  const base = origin(opts.origin);
  const H = (n) => "#".repeat(Math.min(level + n, 6));
  const out = [`${H(0)} Sylo documentation (SYLO / AYZEN ecosystem notes)`, "", `Source: ${base}/docs. Mixed Bengali and English, published as written.`, ""];
  for (const ch of SYLO_DOCS) {
    out.push(`${H(1)} ${ch.n}. ${ch.title}`, "", ch.desc, "");
    for (const t of ch.topics) {
      out.push(`${H(2)} ${t.n} ${t.title}`, `URL: ${base}/docs/${ch.slug}/${t.slug}`, "");
      for (const s of t.subs) {
        out.push(`${H(3)} ${s.n} ${s.title}`, "");
        for (const l of s.lines) out.push(l);
        out.push("");
      }
    }
  }
  return out.join("\n");
}

/** Static files for a build: path (relative to the site root) -> HTML. */
export function docsFiles(opts = {}) {
  const f = {};
  for (const p of docsPages()) f[p.path === "/docs" ? "docs/index.html" : `${p.path.slice(1)}/index.html`] = docsDocument(p, opts);
  return f;
}
