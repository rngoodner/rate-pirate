import { existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ScanDeps } from './scanner/scan.js';
import type { EmailSender } from './alerts/email.js';
import { apiRoutes } from './api/routes.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webDist = resolve(repoRoot, 'web/dist');

export type AppDeps = ScanDeps & { sender?: EmailSender };

export function createApp(deps?: AppDeps) {
  const app = new Hono();

  if (deps) {
    app.route('/api', apiRoutes(deps));
  } else {
    app.get('/api/health', (c) => c.json({ ok: true }));
  }

  // Built SPA (production). In dev, Vite serves the frontend and proxies /api here.
  if (existsSync(webDist)) {
    const root = relative(process.cwd(), webDist);
    // Vite content-hashes /assets/* filenames → cache forever. Everything else
    // (index.html, manifest, icons) must revalidate, or phones keep serving a
    // stale app shell after deploys (no header at all = heuristic caching).
    app.use('*', async (c, next) => {
      await next();
      if (c.res.headers.has('cache-control') || c.req.path.startsWith('/api/')) return;
      c.header(
        'Cache-Control',
        c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    });
    app.use('*', serveStatic({ root }));
    app.use('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
