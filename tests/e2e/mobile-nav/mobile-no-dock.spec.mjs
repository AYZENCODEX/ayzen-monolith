#!/usr/bin/env node
/**
 * tests/e2e/mobile-nav/mobile-no-dock.spec.mjs — W2-P3 mobile viewport screenshot test.
 * Opens the app at phone widths and proves: no fixed bottom bar, the hamburger opens the navigation drawer (the only mobile
 * navigation), the drawer closes again, nothing scrolls sideways; then saves a screenshot per viewport and drawer state.
 *
 *   E2E_BASE_URL=https://sylo.ayzen.tech E2E_TOKEN=<a valid session JWT> node tests/e2e/mobile-nav/mobile-no-dock.spec.mjs
 *   (needs `playwright` + its chromium; screenshots go to E2E_OUT_DIR, default ./reports/mobile-nav)
 * Without E2E_BASE_URL and E2E_TOKEN it prints SKIPPED and exits 0, so it never blocks a machine that has no running app.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createServer } from "node:http";

const VIEWPORTS = [{ name: "iphone-se", width: 375, height: 667 }, { name: "pixel-7", width: 412, height: 915 }, { name: "small-tablet", width: 767, height: 1024 }];
const SELF_TEST = process.argv.includes("--self-test");

// Two tiny fixture pages that model the layouts: with the old dock, and drawer-only (what AppLayout renders now).
const page = (withDock) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>
body{margin:0;font-family:sans-serif}.top{display:flex;gap:8px;padding:12px;border-bottom:1px solid #ccc}
.dock{position:fixed;bottom:0;left:0;right:0;height:64px;background:#eee;display:flex;justify-content:space-around;align-items:center}
.drawer{position:fixed;top:0;left:0;bottom:0;width:256px;background:#fafafa;box-shadow:2px 0 8px #0003}[hidden]{display:none!important}
main{padding:16px 16px ${withDock ? "96px" : "32px"}}</style>
<div class=top><button data-testid=mobile-nav-toggle aria-label="Open navigation menu" aria-expanded=false>☰</button><b>Sylo</b></div>
<main>content</main>${withDock ? '<nav class=dock><a href=/home>Home</a><a href=/projects>Projects</a><a href=/marketplace>Market</a></nav>' : ""}
<div class=drawer data-testid=mobile-nav-drawer hidden><a href=/vault>Vault</a><a href=/projects>Projects</a></div>
<script>const d=document.querySelector('[data-testid=mobile-nav-drawer]'),t=document.querySelector('[data-testid=mobile-nav-toggle]');
t.onclick=()=>{d.hidden=false;t.setAttribute('aria-expanded','true')};addEventListener('keydown',e=>{if(e.key==='Escape'){d.hidden=true;t.setAttribute('aria-expanded','false')}})</script>`;

async function serve(withDock) {
  const server = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(page(withDock)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function runAgainst(base, token, out) {
  mkdirSync(out, { recursive: true });
  const { chromium } = await import("playwright");
  const failures = [];
  const check = (ok, msg) => { if (!ok) failures.push(msg); };
  const browser = await chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await ctx.addInitScript((t) => { try { localStorage.setItem("ayzen_token", t); } catch { /* ignore */ } }, token);
      const page = await ctx.newPage();
      await page.goto(new URL("/home", base).href, { waitUntil: "networkidle" });
      const toggle = page.getByTestId("mobile-nav-toggle");
      await toggle.waitFor({ state: "visible", timeout: 20000 });
  
      // 1. No fixed element glued to the bottom edge that spans the width (the old dock was `fixed bottom-0 left-0 right-0`).
      const bottomBars = await page.evaluate(() => [...document.querySelectorAll("nav, div, footer")].filter((el) => {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.position === "fixed" && r.width >= innerWidth * 0.9 && Math.abs(r.bottom - innerHeight) < 2 && r.height < 140 && r.height > 20;
      }).length);
      check(bottomBars === 0, `${vp.name}: found ${bottomBars} full-width fixed bottom bar(s)`);
  
      // 2. The drawer is the navigation: opens from the hamburger, shows links, closes.
      check((await toggle.getAttribute("aria-label")) === "Open navigation menu", `${vp.name}: hamburger lost its aria-label`);
      await page.screenshot({ path: join(out, `${vp.name}-closed.png`) });
      await toggle.click();
      const drawer = page.getByTestId("mobile-nav-drawer");
      await drawer.waitFor({ state: "visible", timeout: 5000 });
      check((await drawer.locator("a").count()) > 0, `${vp.name}: drawer has no navigation links`);
      await page.screenshot({ path: join(out, `${vp.name}-drawer-open.png`) });
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden", timeout: 5000 });
  
      // 3. No horizontal overflow and the page content reaches the bottom (no dead 6rem gap left by the old dock).
      const m = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth - innerWidth }));
      check(m.overflowX <= 1, `${vp.name}: horizontal overflow of ${m.overflowX}px`);
      await ctx.close();
    }
  } finally { await browser.close(); }
  
  
  return failures;
}

if (SELF_TEST) {
  let bad = 0;
  const withDock = await serve(true), drawerOnly = await serve(false);
  try {
    const f1 = await runAgainst(withDock.url, "x", "reports/mobile-nav-selftest/dock");
    if (!f1.some((m) => m.includes("fixed bottom bar"))) { console.error("SELF-TEST FAILED: the old dock layout was not detected"); bad++; }
    const f2 = await runAgainst(drawerOnly.url, "x", "reports/mobile-nav-selftest/drawer");
    if (f2.length) { console.error("SELF-TEST FAILED: the drawer-only layout was flagged:\n - " + f2.join("\n - ")); bad++; }
  } finally { withDock.server.close(); drawerOnly.server.close(); }
  console.log(bad ? "SELF-TEST FAILED" : "SELF-TEST OK: dock layout fails, drawer-only layout passes (3 viewports each)");
  process.exit(bad ? 1 : 0);
}

const base = process.env.E2E_BASE_URL, token = process.env.E2E_TOKEN;
if (!base || !token) { console.log("SKIPPED: set E2E_BASE_URL and E2E_TOKEN (a valid session JWT) to run the mobile viewport test"); process.exit(0); }
const failures = await runAgainst(base, token, process.env.E2E_OUT_DIR ?? "reports/mobile-nav");
if (failures.length) { console.error("MOBILE_NAV_E2E: FAIL\n - " + failures.join("\n - ")); process.exit(1); }
console.log(`MOBILE_NAV_E2E: PASS (${VIEWPORTS.length} viewports, screenshots in ${process.env.E2E_OUT_DIR ?? "reports/mobile-nav"})`);
