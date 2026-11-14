#!/usr/bin/env node
/**
 * gen-module-og.mjs — W2-P4: render one 1200x630 Open Graph PNG per module into artifacts/ayzen/public/og/<id>.png from the
 * registry landing content (brand tokens + tagline). Needs playwright + chromium (dev-time only; PNGs are committed).
 *   node scripts/gen-module-og.mjs [--check]   (--check: fail if any PNG is missing)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLandingContent, landingIds } from "../packages/module-registry/src/landing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "artifacts/ayzen/public/og");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

if (process.argv.includes("--check")) {
  const missing = landingIds().filter((id) => !fs.existsSync(path.join(outDir, `${id}.png`)));
  if (missing.length) { console.error(`missing OG images: ${missing.join(", ")}`); process.exit(1); }
  console.log(`OK — ${landingIds().length} OG images present`); process.exit(0);
}

const { chromium } = await import("playwright");
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const id of landingIds()) {
  const c = getLandingContent(id), b = c.brand;
  await page.setContent(`<body style="margin:0;width:1200px;height:630px;background:linear-gradient(135deg,${b.bg},${b.surface});color:${b.fg};font-family:system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box;position:relative">
<div style="position:absolute;right:-120px;top:-120px;width:480px;height:480px;border-radius:50%;background:${b.accent};opacity:.18"></div>
<div style="color:${b.accent};font-size:34px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">AYZEN</div>
<div style="font-size:120px;font-weight:800;line-height:1.05;margin:12px 0 20px">${esc(c.label)}</div>
<div style="font-size:42px;color:${b.muted};max-width:900px;line-height:1.25">${esc(c.tagline)}</div>
<div style="margin-top:40px;width:160px;height:10px;border-radius:5px;background:${b.accent}"></div></body>`);
  await page.screenshot({ path: path.join(outDir, `${id}.png`) });
  console.log("wrote", `${id}.png`);
}
await browser.close();
