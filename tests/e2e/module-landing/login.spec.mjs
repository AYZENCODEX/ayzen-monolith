#!/usr/bin/env node
/**
 * Browser check for a module's OWN login page (fyra). Page = designedLoginHtml with the API on ANOTHER origin (static hosting):
 *  - renders the design (heading, tabs), is noindex, brand/back links go to "/",
 *  - sign-in posts to <apiOrigin>/api/auth/login (not the page origin), the token lands in localStorage under ayzen_token,
 *  - the person is sent to ?next= (same-origin path) / the module home.
 *   node tests/e2e/module-landing/login.spec.mjs
 */
import http from "node:http";
import { chromium } from "playwright";
import { designedLoginHtml, loginIds } from "../../../packages/module-registry/src/landing-designs.mjs";

const fail = (m) => { console.error("FAIL " + m); process.exit(1); };
const apiHits = [];
const api = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*"); res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("access-control-allow-methods", "POST,GET,OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    apiHits.push(`${req.method} ${req.url} ${b}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/login") return res.end(JSON.stringify({ token: "tok123", user: { username: "demoadmin", email: "demoadmin@ayzen.io" } }));
    res.statusCode = 404; res.end("{}");
  });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiOrigin = `http://127.0.0.1:${api.address().port}`;
const page = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/login") { res.setHeader("content-type", "text/html"); return res.end(designedLoginHtml("fyra", { apiOrigin })); }
  res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>stub ${u.pathname}</title>`);
});
await new Promise((r) => page.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${page.address().port}`;

if (!loginIds().includes("fyra")) fail("fyra has no login design");
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const p = await ctx.newPage();
const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(`${origin}/login?next=/finance/dashboard`);
await p.waitForSelector("#e");
if (!(await p.textContent("h3")).includes("Welcome back")) fail("design heading missing");
if ((await p.locator('meta[name="robots"]').getAttribute("content")) !== "noindex, nofollow") fail("login must be noindex");
if ((await p.locator("a.brand").getAttribute("href")) !== "/") fail("brand link must go to /");
await p.fill("#e", "demoadmin@ayzen.io"); await p.fill("#p", "Password1!");
await p.click("button.b1");
await p.waitForFunction(() => location.pathname === "/finance/dashboard", null, { timeout: 8000 });
if (!apiHits.some((h) => h.startsWith("POST /api/auth/login"))) fail("login did not reach the API origin: " + JSON.stringify(apiHits));
const tok = await p.evaluate(() => localStorage.getItem("ayzen_token") ?? sessionStorage.getItem("ayzen_token"));
if (tok !== "tok123") fail("token not stored under ayzen_token");
if (errors.length) fail("page errors: " + errors.join("; "));
await browser.close(); api.close(); page.close();
console.log("module login (fyra): design renders, noindex, API on another origin, token stored, redirect to ?next= — OK");
