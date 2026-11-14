#!/usr/bin/env node
/**
 * W2-P4 browser check for the DESIGNED landings (real chromium). A tiny server mimics the production routes
 * ("/" = designedLandingHtml, /landing-assets/* allow-list, /og/*, everything else = stub SPA), third-party hosts (fonts,
 * three.js CDN) are blocked, and for every module we assert:
 *  - no request to /api, /oidc, /.well-known or any auth endpoint while the page loads or idles (no auth call before login),
 *  - no same-origin 404s (all design assets resolve), no page errors apart from the blocked CDN's `THREE`,
 *  - every visible sign-in/sign-up entry goes to /login or /register (never the design's demo auth),
 *  - #login / #signup deep links and a stored token redirect (/login, /register, homePath).
 *   node tests/e2e/module-landing/designed.spec.mjs [--shots <dir>]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MODULES } from "../../../packages/module-registry/src/index.mjs";
import { designedLandingHtml, designAssets, designIds } from "../../../packages/module-registry/src/landing-designs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const hostToId = Object.fromEntries(MODULES.map((m) => [m.id, m.id]));
const allow = new Map(designIds().flatMap((id) => designAssets(id).map((a) => [`/landing-assets/${id}/${a.rel}`, a.abs])));
const MIME = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" };
const hits = [];
let current = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); hits.push(u.pathname);
  if (u.pathname === "/") { res.setHeader("content-type", "text/html"); return res.end(designedLandingHtml(current)); }
  if (allow.has(u.pathname)) { const f = allow.get(u.pathname); res.setHeader("content-type", MIME[path.extname(f)] ?? "application/octet-stream"); return res.end(fs.readFileSync(f)); }
  if (u.pathname.startsWith("/og/")) { const f = path.join(root, "artifacts/ayzen/public", u.pathname); if (fs.existsSync(f)) { res.setHeader("content-type", "image/png"); return res.end(fs.readFileSync(f)); } }
  if (["/login", "/register"].includes(u.pathname) || MODULES.some((m) => m.homePath === u.pathname)) { res.setHeader("content-type", "text/html"); return res.end(`<!doctype html><title>SPA ${u.pathname}</title><body>spa</body>`); }
  res.statusCode = 404; res.end("nf");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error("FAIL", msg); } else console.log("ok  ", msg); };
const FORBIDDEN = /^\/(api|oidc|\.well-known|auth)(\/|$)/;

const browser = await chromium.launch();
for (const m of MODULES) {
  current = m.id;
  const mk = async (vp, init) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    if (init) await page.addInitScript(init);
    const log = { req: [], bad: [], errs: [] };
    page.on("request", (r) => { const u = new URL(r.url()); if (u.origin === origin) log.req.push(u.pathname); });
    page.on("response", (r) => { const u = new URL(r.url()); if (u.origin === origin && r.status() >= 400) log.bad.push(`${r.status()} ${u.pathname}`); });
    page.on("pageerror", (e) => { if (!/THREE/.test(e.message)) log.errs.push(e.message); });
    await page.route((u) => u.origin !== origin, (r) => r.abort());
    return { ctx, page, log };
  };
  for (const vp of [{ width: 1280, height: 800 }, { width: 375, height: 800 }]) {
    const { ctx, page, log } = await mk(vp);
    await page.goto(origin + "/"); await page.waitForTimeout(1500);
    check(!log.req.some((p) => FORBIDDEN.test(p)), `${m.id}@${vp.width}: no auth/API request on load (${log.req.length} same-origin requests)`);
    check(log.bad.length === 0 && log.errs.length === 0, `${m.id}@${vp.width}: no same-origin 404s or page errors ${[...log.bad, ...log.errs].join(" | ")}`);
    check((await page.locator("h1").count()) >= 1, `${m.id}@${vp.width}: has an h1`);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${m.id}-${vp.width}.png`) }); }
    await ctx.close();
  }
  // sign-in entries
  { const { ctx, page } = await mk({ width: 1280, height: 800 });
    await page.goto(origin + "/"); await page.waitForTimeout(500);
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    check(!hrefs.some((h) => /^#(login|signin|signup|register)$|login\/index|login\.html/.test(h)), `${m.id}: no anchor points at the design's demo auth`);
    check(hrefs.some((h) => h === "/login") || (await page.locator("[data-go],[data-signin]").count()) > 0, `${m.id}: a way in exists`);
    await ctx.close(); }
  // header sign-in buttons that are rendered by the design's own script (verve: [data-signin])
  { const { ctx, page } = await mk({ width: 1280, height: 800 });
    await page.goto(origin + "/"); await page.waitForTimeout(800);
    const btn = page.locator("[data-signin]").first();
    if (await btn.count()) { await btn.click(); await page.waitForURL((u) => u.pathname === "/login", { timeout: 4000 }).catch(() => {}); check(new URL(page.url()).pathname === "/login", `${m.id}: [data-signin] -> /login`); }
    await ctx.close(); }
  // deep links + token
  for (const [name, url, init, want] of [
    ["#login", "/#login", null, "/login"], ["#signup", "/#signup", null, "/register"],
    ["token", "/", () => localStorage.setItem("ayzen_token", "t"), m.homePath],
  ]) {
    const { ctx, page } = await mk({ width: 1280, height: 800 }, init);
    await page.goto(origin + url); await page.waitForURL((u) => u.pathname === want, { timeout: 4000 }).catch(() => {});
    check(new URL(page.url()).pathname === want, `${m.id}: ${name} -> ${want}`);
    await ctx.close();
  }
}
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
