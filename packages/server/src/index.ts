import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { initCache, closeCache } from './storage/cache.js';
import { initSigning } from './utils/signing.js';
import healthRouter from './routes/health.js';
import verifyRouter from './routes/verify.js';

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// API routes — mounted under a sub-router so we can serve at both '/' and '/verify/'
// This supports two access paths:
//   1. Domain access via reverse proxy that strips /verify/ prefix (e.g., nginx proxy_pass)
//   2. Direct IP access where the frontend uses /verify/ as its base path
const apiRouter = express.Router();
apiRouter.use('/health', healthRouter);
apiRouter.use('/api/v1/verify', verifyRouter);

apiRouter.get('/api', (_req, res) => {
  res.json({
    name: 'Verify Sidecar',
    version: '0.1.0',
    description: 'Verification and attestation service for Arweave transaction data',
    endpoints: {
      health: 'GET /health',
      verify: 'POST /api/v1/verify',
      result: 'GET /api/v1/verify/:id',
      history: 'GET /api/v1/verify/tx/:txId',
      pdf: 'GET /api/v1/verify/:id/pdf',
      attestation: 'GET /api/v1/verify/:id/attestation',
      docs: 'GET /api-docs/',
    },
  });
});

// Proxy /raw/{txId} to the gateway for data preview (images, etc.)
apiRouter.get('/raw/:txId', async (req, res) => {
  try {
    const gatewayUrl = config.GATEWAY_URL.replace(/\/$/, '');
    const upstream = await fetch(`${gatewayUrl}/raw/${req.params.txId}`);
    if (!upstream.ok) {
      res.status(upstream.status).end();
      return;
    }
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch {
    res.status(502).json({ error: 'Gateway proxy failed' });
  }
});

// OpenAPI / Swagger UI
const __filename_main = fileURLToPath(import.meta.url);
const __dirname_main = dirname(__filename_main);
const specPaths = [
  join(__dirname_main, 'openapi.json'),
  join(__dirname_main, '..', 'src', 'openapi.json'),
];
let openApiSpec: Record<string, unknown> | null = null;
for (const p of specPaths) {
  try {
    openApiSpec = JSON.parse(readFileSync(p, 'utf-8'));
    break;
  } catch {
    // try next
  }
}
if (openApiSpec) {
  apiRouter.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'ar.io Verify API',
  }));
}

app.use('/', apiRouter);
app.use('/verify', apiRouter);

// Serve frontend static files if they exist
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webDistPath = join(__dirname, '..', '..', 'web', 'dist');

if (existsSync(webDistPath)) {
  // Serve static assets under /verify/ (domain access) and / (direct IP access)
  app.use('/verify', express.static(webDistPath));
  app.use(express.static(webDistPath));

  // Redirect root to /verify/ for direct access
  app.get('/', (_req, res) => {
    res.redirect('/verify/');
  });

  // SPA fallback: serve index.html for non-API routes
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/api-docs') ||
      req.path.startsWith('/health') ||
      req.path.startsWith('/verify/api/') ||
      req.path.startsWith('/verify/api-docs') ||
      req.path.startsWith('/verify/health')
    ) {
      next();
      return;
    }
    res.sendFile(join(webDistPath, 'index.html'));
  });
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  closeCache();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
try {
  initCache();
  initSigning();

  app.listen(config.PORT, () => {
    logger.info(`Verify Sidecar running at http://localhost:${config.PORT}`);
  });
} catch (error) {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
}
