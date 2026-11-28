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
import { getModule } from "./index.mjs";
import { loginAdapterScript } from "./login-adapters.mjs";
import { docsFiles, publicFiles, hasDocs, aboutDocument, getLandingContent, landingDocument, landingHead, llmsFullTxt, llmsTxt, robotsTxt, sitemapXml } from "./landing.mjs";

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "landings");
/** Read lazily: a bundled server (esbuild) cannot locate the folder from import.meta.url, so it sets MODULE_LANDINGS_DIR. */
export const designRoot = () => process.env.MODULE_LANDINGS_DIR || DEFAULT_ROOT;
export const LANDING_ASSET_PREFIX = "/landing-assets";
/** verve ships a multi-page static site; its pages resolve relative links through a <base>. */
const BASE_DESIGNS = new Set(["verve"]);
/** Designs whose sign-in/sign-up lives INSIDE the landing (hash routes #login, #signup, #reset) and talks to /api/auth/module/v2.
 *  /login and /register are thin redirects into that portal; the landing keeps its own auth links. */
const PORTAL_DESIGNS = new Set(["ryft", "zynth", "skarn"]);
export const isPortal = (id) => PORTAL_DESIGNS.has(id);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export const designFile = (id) => path.join(designRoot(), id, "index.html");
/** A module's OWN sign-in page (landings/<id>/login.html). Only a design that talks to the real /api/auth routes may be shipped here. */
export const loginFile = (id) => path.join(designRoot(), id, "login.html");
export const hasLogin = (id) => isPortal(id) || fs.existsSync(loginFile(id));
export const loginIds = () => designIds().filter((d) => hasLogin(d));
export const portalIds = () => designIds().filter((d) => isPortal(d));
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
      else { const rel = path.relative(root, abs).split(path.sep).join("/"); if (rel !== "index.html" && rel !== "login.html") out.push({ rel, abs }); }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

const apiShim = (api) => `(function(A){var f=window.fetch;window.fetch=function(u,i){if(typeof u==="string"&&u.indexOf("/api/")===0){u=A+u;i=Object.assign({},i,{credentials:i&&i.credentials==="omit"?"omit":"include"})}return f.call(this,u,i)}})(${JSON.stringify(api)});`;
/** Portal landings: only the "already signed in" hop; hash routes stay in the page. */
const portalGuard = (c) => `<script>window.__AYZEN_HOME=${JSON.stringify(c.homePath)};(function(){try{var t=null;try{t=localStorage.getItem("ayzen_token")||sessionStorage.getItem("ayzen_token")}catch(e){}if(t&&!/^#\\/?(in|up|rst|oidc|login|signup|reset)/.test(location.hash)&&!/[?&]code=/.test(location.search))location.replace(${JSON.stringify(c.homePath)})}catch(e){}})()</script>`;
const guardScript = (c) => `<script>(function(){try{var h=location.hash.replace(/^#\\/?/,"");if(/^(up|signup|register)(\\/|$)/.test(h)){location.replace("/register");return}if(/^(in|login|signin|rst|oidc|welcome)(\\/|$)/.test(h)){location.replace("/login");return}var t=null;try{t=localStorage.getItem("ayzen_token")||sessionStorage.getItem("ayzen_token")}catch(e){}if(t)location.replace(${JSON.stringify(c.homePath)})}catch(e){}})()</script>`;

/** Designs that open their demo sign-in from a button (skarn: data-go) go to the real routes instead. */
const CTA_SCRIPT = `<script>document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-go]");if(!b||b.closest("#auth,#pg-auth,#p-auth"))return;var v=b.getAttribute("data-go")||"";if(!/^(in|up)\\./.test(v))return;e.preventDefault();e.stopImmediatePropagation();location.assign(v.indexOf("up")===0?"/register":"/login")},true)</script>`;

/** A plain crawlable link from the landing to the long-form /about page (and the AI text files). */
const ABOUT_LINK = (c) => `<p data-about-link style="text-align:center;margin:0;padding:18px 16px;font:14px/1.5 system-ui,sans-serif;opacity:.75"><a href="/about" style="color:inherit">About ${esc(c.label)}: features, how it works and FAQ</a> · <a href="/llms.txt" style="color:inherit">llms.txt</a></p>`;

/** Sylo public menu: fixed top-right 3-bar button -> slide-in sidebar (Login, Sign up, public account pages, Access, Docs, About). Only for modules with docs. */
const MENU_LINKS = [
  ["Login", "/login"], ["Sign up", "/register"], null,
  ["Entity", "/explore/entity"], ["Local", "/explore/local"], ["KYC", "/explore/kyc"], ["Game", "/explore/game"], null,
  ["Access", "/explore/access"], ["Public", "/explore/public"], ["Pricing", "/explore/pricing"], null, ["Docs", "/docs"], ["About", "/about"],
];
const SITE_MENU = `<style>#sx-mb{position:fixed;top:14px;right:14px;z-index:2147483001;width:44px;height:44px;border-radius:12px;border:1px solid rgba(128,128,128,.35);background:#141414;color:#fff;display:grid;place-content:center;gap:5px;cursor:pointer}#sx-mb i{display:block;width:20px;height:2px;background:currentColor;border-radius:2px}#sx-sc{position:fixed;inset:0;z-index:2147483002;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .2s}#sx-sd{position:fixed;top:0;right:0;bottom:0;width:min(300px,84vw);z-index:2147483003;background:#111;color:#fff;font:15px/1.4 system-ui,sans-serif;padding:70px 20px 24px;transform:translateX(100%);transition:transform .22s;overflow:auto;display:flex;flex-direction:column;gap:2px}#sx-sd a{color:inherit;text-decoration:none;padding:12px 10px;border-radius:10px}#sx-sd a:hover,#sx-sd a:focus-visible{background:rgba(255,255,255,.1)}#sx-sd hr{border:0;border-top:1px solid rgba(255,255,255,.15);margin:8px 0}#sx-sd small{opacity:.55;padding:6px 10px;text-transform:uppercase;letter-spacing:.08em;font-size:11px}body.sx-open #sx-sc{opacity:1;pointer-events:auto}body.sx-open #sx-sd{transform:none}@media(prefers-reduced-motion:reduce){#sx-sd,#sx-sc{transition:none}}</style>
<button id="sx-mb" type="button" aria-label="Menu" aria-expanded="false" aria-controls="sx-sd"><i></i><i></i><i></i></button><div id="sx-sc"></div>
<nav id="sx-sd" aria-label="Menu">${MENU_LINKS.map((l, i) => (l ? (i === 3 ? "<small>Accounts</small>" : "") + `<a href="${l[1]}">${l[0]}</a>` : "<hr>")).join("")}</nav>
<script>(function(){var b=document.getElementById("sx-mb"),d=document.body;function t(o){d.classList.toggle("sx-open",o);b.setAttribute("aria-expanded",o)}b.onclick=function(){t(!d.classList.contains("sx-open"))};document.getElementById("sx-sc").onclick=function(){t(false)};document.addEventListener("keydown",function(e){if(e.key==="Escape")t(false)});document.getElementById("sx-sd").addEventListener("click",function(e){if(e.target.closest("a"))t(false)})})()</script>`;

const PILL = `<a href="/login" data-ayzen-signin style="position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:12px 20px;border-radius:999px;background:#111;color:#fff;font:600 14px/1 system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 24px rgba(0,0,0,.3)">Sign in</a>`;

/** The production HTML for a module's landing at "/". */
export function designedLandingHtml(id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return null;
  if (!hasDesign(id)) return landingDocument(c, opts).replace(/<head>/i, (m) => `${m}\n${guardScript(c)}`);
  const h = landingHead(c, opts);
  let html = fs.readFileSync(designFile(id), "utf8");

  // 1) sign-in/up entries -> the real SPA routes (never the design's demo auth)
  if (!isPortal(id)) html = html
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
    html = html.replace(/\b(href|src)="(?:\.\/)?((?:assets|fonts|media)\/)/g, `$1="${assetBase}$2`).replace(/url\((['"]?)(?:\.\/)?((?:assets|fonts|media)\/)/g, `url($1${assetBase}$2`);
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
    `<link rel="alternate" type="text/markdown" href="/llms-full.txt" title="${esc(c.label)} for AI assistants" />`,
  ].join("\n");
  if (!/<html[^>]*\blang=/i.test(html)) html = html.replace(/<html/i, '<html lang="en"');
  html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${isPortal(id) ? portalGuard(c) + (opts.apiOrigin ? `<script>${apiShim(String(opts.apiOrigin).replace(/\/+$/, ""))}</script>` : "") : guardScript(c)}\n${baseTag}\n${seo}`);

  // 4) every design must offer a way in
  if (!isPortal(id) && !BASE_DESIGNS.has(id) && !/href="\/login"|data-go="in\./.test(html)) html = html.replace(/<\/body>/i, `${PILL}\n</body>`);
  html = html.replace(/<\/body>/i, `${hasDocs(id) ? SITE_MENU + "\n" : ""}${ABOUT_LINK(c)}\n${isPortal(id) ? "" : CTA_SCRIPT}\n</body>`);
  return html;
}

/**
 * The module's own sign-in page, exactly as designed, plus a runtime prelude:
 *  - always: the module's OIDC client id (the design reads window.<ID>_OIDC_CLIENT_ID);
 *  - when the API lives on another origin (static hosting, opts.apiOrigin): "/api/..." fetches go to that origin (the same rewrite
 *    lib/api-routing.ts applies inside the SPA) and the OIDC issuer is that origin.
 * Brand/back links "/<id>/" point at "/". The page is noindex (a sign-in form has no search value).
 */
/** /login and /register of a portal design: straight into the landing's own flow, keeping ?next= (same-origin paths only). */
export function portalRedirectHtml(id, mode = "login") {
  if (!isPortal(id)) return null;
  const hash = id === "skarn" ? (mode === "signup" ? "#/up/cred" : "#/in/cred") : mode === "signup" ? "#signup" : "#login";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Redirecting…</title><script>(function(){var n=new URLSearchParams(location.search).get("next");var q=n&&/^\\/(?!\\/)/.test(n)?"?next="+encodeURIComponent(n):"";location.replace("/"+q+"${hash}")})()</script><noscript><meta http-equiv="refresh" content="0;url=/${hash}"></noscript></head><body><a href="/${hash}">Continue</a></body></html>`;
}
export const designedRegisterHtml = (id) => portalRedirectHtml(id, "signup");

export function designedLoginHtml(id, opts = {}) {
  // A portal design with its own login page serves it; without one, /login falls back to the landing's embedded sign-in.
  if (isPortal(id) && !fs.existsSync(loginFile(id))) return portalRedirectHtml(id, "login");
  if (!hasLogin(id)) return null;
  const m = getModule(id);
  const P = id.toUpperCase();
  const api = opts.apiOrigin ? String(opts.apiOrigin).replace(/\/+$/, "") : "";
  const prelude = [
    `window.${P}_OIDC_CLIENT_ID=${JSON.stringify(m.oidcClientId)};`,
    api
      ? `window.${P}_OIDC_ISSUER=${JSON.stringify(api)};(function(A){var f=window.fetch;window.fetch=function(u,i){if(typeof u==="string"&&u.indexOf("/api/")===0){u=A+u;i=Object.assign({},i,{credentials:i&&i.credentials==="omit"?"omit":"include"})}return f.call(this,u,i)}})(${JSON.stringify(api)});`
      : "",
    loginAdapterScript(id),
  ].join("");
  let html = fs.readFileSync(loginFile(id), "utf8").replace(/href="\/[a-z]+\/"/g, 'href="/"');
  // Multi-page designs (verve) resolve their relative css/js through a <base>, exactly like their landing.
  const baseTag = BASE_DESIGNS.has(id) ? `<base href="${LANDING_ASSET_PREFIX}/${id}/">` : "";
  html = html.replace(/<head[^>]*>/i, (h) => `${h}<meta name="robots" content="noindex, nofollow"><script>${prelude}</script>${baseTag}`);
  return html;
}

/** Everything a module serves besides the SPA: landing, own login, about, robots/sitemap/llms. Used by the module build (dir = dist root) and the central build (dir = dist/m/<id>). */
export function emitModuleSite(id, dir, opts = {}) {
  const w = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  w("index.html", designedLandingHtml(id, opts));
  const login = designedLoginHtml(id, opts);
  if (login) w("login/index.html", login);
  const reg = designedRegisterHtml(id);
  if (reg) w("register/index.html", reg);
  w("robots.txt", robotsTxt(id, opts));
  w("sitemap.xml", sitemapXml(id, opts));
  w("llms.txt", llmsTxt(id, opts));
  w("llms-full.txt", llmsFullTxt(id, opts));
  w("about/index.html", aboutDocument(getLandingContent(id), opts));
  if (hasDocs(id)) for (const [rel, html] of Object.entries({ ...docsFiles(opts), ...publicFiles(opts) })) w(rel, html);
}

/** Design assets under <outRoot>/landing-assets/<id>/ (the prefix the landing HTML refers to). */
export function emitLandingAssets(id, outRoot) {
  for (const a of designAssets(id)) {
    const dest = path.join(outRoot, LANDING_ASSET_PREFIX.slice(1), id, a.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(a.abs, dest);
  }
}
