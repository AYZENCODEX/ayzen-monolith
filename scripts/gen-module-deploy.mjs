#!/usr/bin/env node
/**
 * scripts/gen-module-deploy.mjs — W2-P2: one deploy target per module, generated from the module registry (never hand-edited).
 *   node scripts/gen-module-deploy.mjs           # write deploy/modules/<id>/vercel.json + deploy/modules/manifest.json
 *   node scripts/gen-module-deploy.mjs --check   # fail if the committed files differ (CI)
 * Layout: single repo, one Vercel project per module (project name `ayzen-<id>`, domain = the module's host), each deployed with
 *   vercel deploy --prod --local-config deploy/modules/<id>/vercel.json
 * Each project builds ONLY its own module bundle (VITE_MODULE) and serves it as a static SPA; the API stays on VITE_API_URL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const API_ORIGIN = "https://api.ayzen.tech";

export function renderAll(modules) {
  const files = new Map();
  const manifest = { generatedFrom: "packages/module-registry", apiOrigin: API_ORIGIN, modules: [] };
  for (const m of modules) {
    const config = {
      $schema: "https://openapi.vercel.sh/vercel.json",
      framework: null,
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm --filter @workspace/ayzen run build:module",
      outputDirectory: `artifacts/ayzen/dist/modules/${m.id}`,
      build: { env: { VITE_MODULE: m.id, VITE_API_URL: API_ORIGIN } },
      // Static files first (Vercel serves the filesystem before rewrites), everything else is the SPA shell (app.html; index.html is the module's public landing, W2-P4).
      rewrites: [{ source: "/(.*)", destination: "/app.html" }],
      headers: [
        {
          source: "/(.*)",
          headers: [
            { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
            { key: "Referrer-Policy", value: "no-referrer" },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          ],
        },
        { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      ],
    };
    files.set(`deploy/modules/${m.id}/vercel.json`, JSON.stringify(config, null, 2) + "\n");
    manifest.modules.push({ id: m.id, host: m.defaultHost, vercelProject: `ayzen-${m.id}`, config: `deploy/modules/${m.id}/vercel.json`, buildEnv: config.build.env });
  }
  files.set("deploy/modules/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { MODULES } = await import("../packages/module-registry/src/index.mjs");
  const files = renderAll(MODULES);
  if (process.argv.includes("--check")) {
    const stale = [...files].filter(([f, c]) => !existsSync(join(ROOT, f)) || readFileSync(join(ROOT, f), "utf8") !== c).map(([f]) => f);
    if (stale.length) { console.error("MODULE_DEPLOY: STALE (run node scripts/gen-module-deploy.mjs)\n - " + stale.join("\n - ")); process.exit(1); }
    console.log(`MODULE_DEPLOY: PASS (${files.size} files up to date)`);
  } else {
    for (const [f, c] of files) { mkdirSync(dirname(join(ROOT, f)), { recursive: true }); writeFileSync(join(ROOT, f), c); }
    console.log(`wrote ${files.size} files under deploy/modules/`);
  }
}
