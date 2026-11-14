/**
 * vite.module.config.ts — W2-P2 (req 4): one build per module.
 *
 *   VITE_MODULE=sylo vite build --config vite.module.config.ts      # -> dist/modules/sylo
 *   pnpm --filter @workspace/ayzen build:module  (reads VITE_MODULE)   |   build:modules  (all eight)
 *
 * What makes the bundle module-only: every page that belongs to ANOTHER module (build/module-pages.mjs: route path -> owner
 * from the module registry, propagated along page-to-page imports) is swapped for an empty stub while the module graph is
 * resolved, so its code, and everything only it imports, never reaches the bundle. Unowned pages (core, admin, platform) stay
 * because every module host still needs them. The plugin then inspects the finished bundle and FAILS the build if any
 * excluded page file is still in a chunk, and writes dist/module-reports/<module>.json (the bundle report: pages included,
 * pages stubbed, chunk sizes). The fast, install-free version of the same proof is scripts/check-module-bundles.mjs (CI).
 *
 * The full/central build (vite.config.ts) is unchanged.
 */
import { robotsTxt, sitemapXml } from '@ayzen/module-registry/landing';
import { designedLandingHtml, designAssets, LANDING_ASSET_PREFIX } from '@ayzen/module-registry/landing-designs';
import fs from 'fs';
import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { MODULE_IDS, getModuleIdForPath } from '@ayzen/module-registry';
import { analyzeRouteConfig, excludedPagesFor, includedPagesFor, propagateOwnership } from './build/module-pages.mjs';
import { importsOf } from './build/import-graph.mjs';

const moduleId = (process.env.VITE_MODULE ?? '').trim().toLowerCase();
if (!(MODULE_IDS as readonly string[]).includes(moduleId)) {
  throw new Error(`VITE_MODULE must be one of: ${MODULE_IDS.join(', ')} (got "${process.env.VITE_MODULE ?? ''}")`);
}

const root = path.resolve(import.meta.dirname);
const src = path.join(root, 'src');
const STUB_PREFIX = '\0ayzen-module-stub:';
const clean = (id: string) => id.split('?')[0].replace(/\\/g, '/');

const toAbs = (rel: string): string | null => {
  for (const ext of ['.tsx', '.ts']) { const p = path.join(src, rel + ext); if (fs.existsSync(p)) return p; }
  return null;
};

function moduleBuildPlugin(): Plugin {
  const analysis = propagateOwnership(
    analyzeRouteConfig(fs.readFileSync(path.join(src, 'lib/route-config.tsx'), 'utf8'), { getModuleIdForPath }),
    (f: string) => importsOf(f, src),
    toAbs,
  );
  const excludedRel = excludedPagesFor(analysis, moduleId);
  const includedRel = includedPagesFor(analysis, moduleId);
  const excludedAbs = new Map<string, string>();
  for (const rel of excludedRel) { const a = toAbs(rel); if (a) excludedAbs.set(clean(a), rel); }

  return {
    name: 'ayzen-module-build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source.startsWith(STUB_PREFIX)) return source;
      if (!importer || !(source.startsWith('@/') || source.startsWith('.'))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const rel = resolved && excludedAbs.get(clean(resolved.id));
      return rel ? STUB_PREFIX + rel : null;
    },
    load(id) {
      if (id.startsWith(STUB_PREFIX)) return 'export default function ModuleExcludedPage() { return null; }\n';
      return null;
    },
    // W2-P4: the module's public landing becomes index.html ("/"), the SPA shell moves to app.html (the static host's rewrite
    // target, see scripts/gen-module-deploy.mjs). Landing assets go to /landing-assets/<id>/. Written AFTER Vite copies public/.
    closeBundle() {
      const out = path.join(root, 'dist/modules', moduleId);
      if (!fs.existsSync(out)) return;
      fs.renameSync(path.join(out, 'index.html'), path.join(out, 'app.html'));
      fs.writeFileSync(path.join(out, 'index.html'), designedLandingHtml(moduleId)!);
      for (const a of designAssets(moduleId)) {
        const dest = path.join(out, LANDING_ASSET_PREFIX.slice(1), moduleId, a.rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(a.abs, dest);
      }
      fs.writeFileSync(path.join(out, 'robots.txt'), robotsTxt(moduleId));
      fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemapXml(moduleId));
    },
    generateBundle(_options, bundle) {

      const chunks: { name: string; bytes: number }[] = [];
      const pagesInBundle = new Set<string>();
      const stubsInBundle = new Set<string>();
      const forbidden: string[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        chunks.push({ name: item.fileName, bytes: item.code.length });
        for (const id of Object.keys(item.modules)) {
          if (id.startsWith(STUB_PREFIX)) { stubsInBundle.add(id.slice(STUB_PREFIX.length)); continue; }
          const c = clean(id);
          if (excludedAbs.has(c)) forbidden.push(excludedAbs.get(c)!);
          const m = /\/src\/(pages\/.+?)\.tsx?$/.exec(c);
          if (m) pagesInBundle.add(m[1]);
        }
      }
      const report = {
        module: moduleId,
        generatedAt: new Date().toISOString(),
        pages: { includedByPolicy: includedRel.length, inBundle: pagesInBundle.size, stubbed: stubsInBundle.size, otherModulePagesInBundle: forbidden.length },
        forbidden: [...new Set(forbidden)].sort(),
        stubbedPages: [...stubsInBundle].sort(),
        chunks: chunks.sort((a, b) => b.bytes - a.bytes),
        totalBytes: chunks.reduce((n, c) => n + c.bytes, 0),
      };
      const dir = path.join(root, 'dist/module-reports');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${moduleId}.json`), JSON.stringify(report, null, 2));
      if (report.forbidden.length > 0) {
        this.error(`${moduleId} bundle contains other modules' pages: ${report.forbidden.join(', ')}`);
      }
    },
  };
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [moduleBuildPlugin(), react(), tailwindcss()],
  define: { 'import.meta.env.VITE_MODULE': JSON.stringify(moduleId) },
  resolve: {
    alias: {
      '@': src,
      '@assets': path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root,
  build: {
    outDir: path.join(root, 'dist/modules', moduleId),
    emptyOutDir: true,
  },
});
