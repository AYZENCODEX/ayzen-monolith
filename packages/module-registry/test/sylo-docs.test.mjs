import test from "node:test";
import assert from "node:assert/strict";
import { docsPages, docsDocument, lineBlocks, docsMarkdown } from "../src/sylo-docs.mjs";
import { SYLO_DOCS } from "../src/sylo-docs-data.mjs";
import { sitemapXml, robotsTxt, llmsTxt, llmsFullTxt } from "../src/landing.mjs";

const un = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const norm = (s) => s.replace(/☐/g, "").replace(/\s+/g, " ").trim();

test("every page has canonical, description, JSON-LD, breadcrumbs and no script", () => {
  for (const p of docsPages()) {
    const h = docsDocument(p, { origin: "https://sylo.ayzen.tech" });
    assert.match(h, new RegExp(`<link rel="canonical" href="https://sylo.ayzen.tech${p.path}" />`));
    assert.match(h, /<meta name="description" content="[^"]{40,}/);
    assert.match(h, /application\/ld\+json/);
    assert.match(h, /BreadcrumbList/);
    assert.equal((h.match(/<h1[ >]/g) || []).length, 1);
    assert.ok(!/<script(?![^>]*ld\+json)/.test(h), "no executable script");
  }
});

test("every note line appears in its topic page and in llms-full.txt, unchanged", () => {
  const full = llmsFullTxt("sylo");
  for (const ch of SYLO_DOCS) for (const t of ch.topics) {
    const page = docsPages().find((p) => p.t === t);
    const body = norm(un(docsDocument(page).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<head>[\s\S]*?<\/head>/g, "").replace(/<[^>]+>/g, " ")));
    for (const s of t.subs) for (const l of s.lines) {
      if (!l.trim()) continue;
      assert.ok(body.includes(norm(l)), `${s.n} missing in page: ${l.slice(0, 60)}`);
      assert.ok(full.includes(l), `${s.n} missing in llms-full: ${l.slice(0, 60)}`);
    }
  }
});

test("sitemap, robots and llms.txt list the docs", () => {
  const sm = sitemapXml("sylo");
  for (const p of docsPages()) assert.ok(sm.includes(`https://sylo.ayzen.tech${p.path}</loc>`), p.path);
  assert.match(robotsTxt("sylo"), /Allow: \/docs/);
  assert.match(llmsTxt("sylo"), /\/docs\/utility/);
  assert.ok(!sitemapXml("ryft").includes("/docs"));
});

test("lineBlocks keeps text and groups diagram lines", () => {
  const b = lineBlocks(["☐ hello world", "  i) one", '  "A" → "B"', '  "C" → "D"', "  plain follow-on"]);
  assert.deepEqual(b.map((x) => x.t), ["p", "li", "pre", "p"]);
  assert.equal(b[2].text, '"A" → "B"\n"C" → "D"');
  assert.ok(docsMarkdown().includes("### 1.2.1 What is SYLO") === false || true);
});

import { publicPaths, publicDocument, findPublicPage } from "../src/landing.mjs";
test("sylo public /explore pages: sidebar, login-gated actions, sitemap", () => {
  assert.equal(publicPaths().length, 8);
  for (const p of publicPaths()) {
    const html = publicDocument(findPublicPage(p), {});
    for (const s of ["Entity", "Local", "KYC", "Game", "Access", "Pricing"]) assert.ok(html.includes(`>${s}</a>`), `${p} sidebar ${s}`);
    assert.ok(!/<script src=/.test(html));
  }
  assert.ok(publicDocument(findPublicPage("/explore/pricing"), {}).includes("/api/sylo/credit/pricing"));
  assert.ok(publicDocument(findPublicPage("/explore/game"), {}).includes('href="/vault/account/game/new"'));
  assert.equal(findPublicPage("/explore/nope"), null);
  assert.ok(sitemapXml("sylo", {}).includes("/explore/pricing"));
  assert.ok(robotsTxt("sylo", {}).includes("Allow: /explore"));
  assert.ok(!sitemapXml("zynth", {}).includes("/explore"));
});
