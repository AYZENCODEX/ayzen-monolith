import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import { defineConfig, type Plugin } from 'vite';
import { MODULE_IDS } from '@ayzen/module-registry';
import { designIds, loginIds, emitModuleSite, emitLandingAssets } from '@ayzen/module-registry/landing-designs';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT ?? '5000';

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

// Module landings on the CENTRAL build: a module host that still runs this bundle (one Vercel project, many domains) is handed to its
// designed landing / own login, which are emitted as plain static files under /m/<id>/ (see lib/module-landing-gate.ts: designHandoff).
function moduleSitesPlugin(): Plugin {
  return {
    name: 'ayzen-module-sites',
    closeBundle() {
      const out = path.resolve(import.meta.dirname, 'dist/public');
      if (!fs.existsSync(out)) return;
      for (const id of designIds()) {
        emitModuleSite(id, path.join(out, 'm', id), { apiOrigin: process.env.VITE_API_URL || undefined });
        emitLandingAssets(id, out);
      }
    },
  };
}

export default defineConfig({
  base: basePath,
  define: {
    'import.meta.env.VITE_LANDING_DESIGNS': JSON.stringify(designIds().filter((d) => (MODULE_IDS as readonly string[]).includes(d)).join(',')),
    'import.meta.env.VITE_LOGIN_DESIGNS': JSON.stringify(loginIds().join(',')),
  },
  plugins: [
    react(),
    moduleSitesPlugin(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
