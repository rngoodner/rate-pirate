import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp();

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`rate-pirate server listening on http://localhost:${info.port}`);
});
