import { existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ScanDeps } from './scanner/scan.js';
import { runScanBatch } from './scanner/scan.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webDist = resolve(repoRoot, 'web/dist');

export function createApp(deps?: ScanDeps) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  if (deps) {
    app.post('/api/scan', async (c) => {
      const result = await runScanBatch(deps);
      return c.json(result);
    });
  }

  // Built SPA (production). In dev, Vite serves the frontend and proxies /api here.
  if (existsSync(webDist)) {
    const root = relative(process.cwd(), webDist);
    app.use('*', serveStatic({ root }));
    app.use('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
