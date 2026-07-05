import { existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ScanDeps } from './scanner/scan.js';
import { runScanBatch } from './scanner/scan.js';
import type { EmailSender } from './alerts/email.js';
import { alertHtml, alertSubject } from './alerts/template.js';
import { getSettings } from './db/settings.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const webDist = resolve(repoRoot, 'web/dist');

export type AppDeps = ScanDeps & { sender?: EmailSender };

export function createApp(deps?: AppDeps) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  if (deps) {
    app.post('/api/scan', async (c) => {
      const result = await runScanBatch(deps);
      return c.json(result);
    });

    app.post('/api/test-email', async (c) => {
      const sender = deps.sender;
      if (!sender) return c.json({ error: 'no email sender configured' }, 503);
      const settings = getSettings(deps.db, deps.config);
      if (!settings.alertEmail) return c.json({ error: 'no alert email configured' }, 400);
      const sample = {
        origin: settings.homeAirport,
        destination: 'NAP',
        city: 'Naples',
        country: 'Italy',
        travelMonth: '2026-08',
        priceCents: 75800,
        baselineCents: 112300,
        discountPct: 0.33,
        score: 93,
        departDate: '2026-08-18',
        returnDate: '2026-08-26',
      };
      try {
        await sender.send({
          to: settings.alertEmail,
          subject: `[test] ${alertSubject(sample)}`,
          html: alertHtml(sample),
        });
        return c.json({ sent: true, via: sender.name, to: settings.alertEmail });
      } catch (err) {
        return c.json({ sent: false, error: String(err) }, 502);
      }
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
