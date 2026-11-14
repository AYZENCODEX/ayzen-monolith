/**
 * landing-designs.mjs — W2-P4: the designed public landings (landings/<id>/index.html) turned into production documents.
 * NODE ONLY (reads files); the SPA never imports it. Used by the module build, the Express app and the validators.
 *
 * Source designs are standalone pages with their own CSS/JS. Three of them (ryft, skarn, zynth) also embed a DEMO sign-in
 * (in-memory accounts, on-screen "demo code"). That must never act as a login on a production host, so every sign-in/sign-up
 * entry is rewritten to the real SPA routes (/login, /register) and the demo hash routes are redirected there too.
 * Nothing else in a design is changed. A module with no design file (sylo) gets the generic registry landing document.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLandingContent, landingDocument, landingHead } from "./landing.mjs";

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "landings");
/** Read lazily: a bundled server (esbuild) cannot locate the folder from import.meta.url, so it sets MODULE_LANDINGS_DIR. */
export const designRoot = () => process.env.MODULE_LANDINGS_DIR || DEFAULT_ROOT;
export const LANDING_ASSET_PREFIX = "/landing-assets";
/** verve ships a multi-page static site; its pages resolve relative links through a <base>. */
const BASE_DESIGNS = new Set(["verve"]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export const designFile = (id) => path.join(designRoot(), id, "index.html");
export const hasDesign = (id) => fs.existsSync(designFile(id));
export const designIds = () => (fs.existsSync(designRoot()) ? fs.readdirSync(designRoot()).filter((d) => hasDesign(d)) : []);

/** Files shipped next to the landing (fonts, css, js, sibling pages) as {rel, abs}; the landing's own index.html is excluded. */
export function designAssets(id) {
  const root = path.join(designRoot(), id);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else { const rel = path.relative(root, abs).split(path.sep).join("/"); if (rel !== "index.html") out.push({ rel, abs }); }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

const guardScript = (c) => `<script>(function(){try{var h=location.hash.replace(/^#\\/?/,"");if(/^(up|signup|register)(\\/|$)/.test(h)){location.replace("/register");return}if(/^(in|login|signin|rst|oidc|welcome)(\\/|$)/.test(h)){location.replace("/login");return}var t=null;try{t=localStorage.getItem("ayzen_token")||sessionStorage.getItem("ayzen_token")}catch(e){}if(t)location.replace(${JSON.stringify(c.homePath)})}catch(e){}})()</script>`;

/** Designs that open their demo sign-in from a button (skarn: data-go) go to the real routes instead. */
const CTA_SCRIPT = `<script>document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-go]");if(!b||b.closest("#auth,#pg-auth,#p-auth"))return;var v=b.getAttribute("data-go")||"";if(!/^(in|up)\\./.test(v))return;e.preventDefault();e.stopImmediatePropagation();location.assign(v.indexOf("up")===0?"/register":"/login")},true)</script>`;

const PILL = `<a href="/login" data-ayzen-signin style="position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:12px 20px;border-radius:999px;background:#111;color:#fff;font:600 14px/1 system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 24px rgba(0,0,0,.3)">Sign in</a>`;

/** The production HTML for a module's landing at "/". */
export function designedLandingHtml(id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return null;
  if (!hasDesign(id)) return landingDocument(c, opts).replace(/<head>/i, (m) => `${m}\n${guardScript(c)}`);
  const h = landingHead(c, opts);
  let html = fs.readFileSync(designFile(id), "utf8");

  // 1) sign-in/up entries -> the real SPA routes (never the design's demo auth)
  html = html
    .replace(/href="#(?:\/)?(?:up|signup|register)(?:\/[^"]*)?"/g, 'href="/register"')
    .replace(/href="#(?:\/)?(?:in|login|signin|rst|oidc|welcome)(?:\/[^"]*)?"/g, 'href="/login"')
    .replace(/(<a\b[^>]*?) data-login\b/g, "$1")
    .replace(/href="(?:\.\/)?login(?:\/index)?\.html"/g, 'href="/login"')
    .replace(/action="(?:\.\/)?login(?:\/index)?\.html"/g, 'action="/login"')
    .replace(/href="\/[a-z]+\/"/g, 'href="/"');

  // 2) assets: absolute under /landing-assets/<id>/ (or a <base> for the multi-page verve site)
  const assetBase = `${LANDING_ASSET_PREFIX}/${id}/`;
  let baseTag = "";
  if (BASE_DESIGNS.has(id)) {
    baseTag = `<base href="${assetBase}">`;
    html = html.replace(/href="#([^"]+)"/g, 'href="/#$1"');
  } else {
    html = html.replace(/\b(href|src)="((?:assets|fonts|media)\/)/g, `$1="${assetBase}$2`).replace(/url\((['"]?)((?:assets|fonts|media)\/)/g, `url($1${assetBase}$2`);
  }

  // 3) head: drop the design's own SEO tags, add the registry ones (same set for all 8 modules)
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
  const keepTitle = title && title.length <= 70;
  html = html
    .replace(/<meta\s+(?:name|property)="(?:description|robots|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "")
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/g, "");
  const seo = [
    `<title>${esc(keepTitle ? title : h.title)}</title>`,
    `<meta name="description" content="${esc(h.description)}" />`,
    `<meta name="robots" content="index, follow" />`,
    `<link rel="canonical" href="${esc(h.canonical)}" />`,
    `<meta property="og:type" content="website" /><meta property="og:site_name" content="${esc(c.label)}" /><meta property="og:title" content="${esc(keepTitle ? title : h.title)}" />`,
    `<meta property="og:description" content="${esc(h.description)}" /><meta property="og:url" content="${esc(h.canonical)}" /><meta property="og:image" content="${esc(h.image)}" />`,
    `<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:alt" content="${esc(c.label)} — ${esc(c.tagline)}" />`,
    `<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(keepTitle ? title : h.title)}" /><meta name="twitter:description" content="${esc(h.description)}" /><meta name="twitter:image" content="${esc(h.image)}" />`,
    `<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>`,
  ].join("\n");
  if (!/<html[^>]*\blang=/i.test(html)) html = html.replace(/<html/i, '<html lang="en"');
  html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${guardScript(c)}\n${baseTag}\n${seo}`);

  // 4) every design must offer a way in
  if (!BASE_DESIGNS.has(id) && !/href="\/login"|data-go="in\./.test(html)) html = html.replace(/<\/body>/i, `${PILL}\n</body>`);
  html = html.replace(/<\/body>/i, `${CTA_SCRIPT}\n</body>`);
  return html;
}
