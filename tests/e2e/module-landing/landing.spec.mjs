#!/usr/bin/env node
/**
 * W2-P4 browser check (real chromium): for every module, the prerendered landing (module shell + injected head/body)
 *  - makes ZERO requests besides the document itself (so no auth/API call before login),
 *  - shows one h1, the pricing CTA and a FAQ, with no horizontal scroll at 375px,
 *  - is cleared by the inline guard when a token exists or the path is not "/".
 *   node tests/e2e/module-landing/landing.spec.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { injectLandingIntoHtml, landingIds } from "../../../packages/module-registry/src/landing.mjs";
import { getModule } from "../../../packages/module-registry/src/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const shell = fs.readFileSync(path.join(root, "artifacts/ayzen/index.html"), "utf8")
  // the real app entry would be requested by a real build; here we assert what the LANDING itself requests
  .replace(/<script type="module"[^>]*><\/script>/, "").replace(/<link[^>]*(manifest|fonts)[^>]*>/g, "");
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.error("FAIL", msg); } else console.log("ok  ", msg); };

const browser = await chromium.launch();
for (const id of landingIds()) {
  const host = getModule(id).defaultHost;
  for (const vp of [{ width: 375, height: 800 }, { width: 1280, height: 800 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const reqs = [], errs = [];
    page.on("request", (r) => reqs.push(r.url()));
    page.on("pageerror", (e) => errs.push(e.message));
    await page.route("**/*", (r) => r.request().url() === `https://${host}/` ? r.fulfill({ contentType: "text/html", body: injectLandingIntoHtml(shell, id, { origin: `https://${host}` }) }) : r.abort());
    await page.goto(`https://${host}/`);
    const h1 = await page.locator("h1").count();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(reqs.length === 1 && errs.length === 0, `${id}@${vp.width}: only the document was requested (${reqs.length}), no page errors`);
    check(h1 === 1 && !overflow && (await page.locator("#pricing a").count()) === 1 && (await page.locator("details").count()) >= 5, `${id}@${vp.width}: h1, pricing CTA, FAQ, no horizontal scroll`);
    await ctx.close();
  }
  // guard: token present, or deep path -> body cleared before the app mounts
  for (const mode of ["token", "deep"]) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const url = mode === "deep" ? `https://${host}/login` : `https://${host}/`;
    await page.route("**/*", (r) => r.request().url() === url ? r.fulfill({ contentType: "text/html", body: injectLandingIntoHtml(shell, id) }) : r.abort());
    if (mode === "token") await page.addInitScript(() => localStorage.setItem("ayzen_token", "t"));
    await page.goto(url);
    check((await page.locator("[data-module-landing]").count()) === 0, `${id}: landing cleared for ${mode}`);
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
