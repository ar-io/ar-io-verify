import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import swaggerUi from 'swagger-ui-express';
import { config, resolvePublicGatewayUrl } from './config.js';
import { logger } from './utils/logger.js';
import { initDb, closeDb } from './storage/db.js';
import { initCache, closeCache } from './storage/cache.js';
import { initJobsStore, sweepStaleRunning, pruneOldJobs } from './storage/jobs.js';
import { resumePending, startStallDetector, stopStallDetector } from './pipeline/job-worker.js';
import { initSigning } from './utils/signing.js';
import healthRouter from './routes/health.js';
import verifyRouter from './routes/verify.js';
import jobsRouter from './routes/jobs.js';

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
// 16 MB JSON body covers a job submission of up to MAX_TX_IDS_PER_JOB (50k)
// at ~50 bytes/txId. Express defaults to 100 KB, which would silently 413
// any meaningful batch job before zod validation gets a chance to surface
// a useful error.
app.use(express.json({ limit: '16mb' }));

// API routes — mounted under a sub-router so we can serve at both '/' and '/verify/'
// This supports two access paths:
//   1. Domain access via reverse proxy that strips /verify/ prefix (e.g., nginx proxy_pass)
//   2. Direct IP access where the frontend uses /verify/ as its base path
const apiRouter = express.Router();
apiRouter.use('/health', healthRouter);
apiRouter.use('/api/v1/verify', verifyRouter);
apiRouter.use('/api/v1/jobs', jobsRouter);

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
      jobsCreate: 'POST /api/v1/jobs',
      jobsStatus: 'GET /api/v1/jobs/:id',
      jobsResults: 'GET /api/v1/jobs/:id/results',
      jobsCancel: 'DELETE /api/v1/jobs/:id',
      jobsEvents: 'GET /api/v1/jobs/events',
      config: 'GET /api/config',
      docs: 'GET /api-docs/',
    },
  });
});

// Runtime config for the frontend (public gateway URL for image previews, etc.)
apiRouter.get('/api/config', (_req, res) => {
  res.json({ publicGatewayUrl: resolvePublicGatewayUrl() });
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
  apiRouter.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'ar.io Verify API',
    })
  );
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

// Periodic pruner for jobs/runs/results/events. Cascades through ON DELETE
// CASCADE so trimming jobs trims their child rows. Mirrors the existing
// verification-results cache prune cadence.
const JOBS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const JOBS_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let jobsPruneTimer: ReturnType<typeof setInterval> | null = null;

function startJobsPruner(): void {
  if (jobsPruneTimer) return;
  const tick = (): void => {
    try {
      const result = pruneOldJobs(JOBS_RETENTION_MS);
      if (result.jobs > 0 || result.events > 0) {
        logger.info(result, 'Pruned old jobs/events');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to prune old jobs');
    }
  };
  tick();
  jobsPruneTimer = setInterval(tick, JOBS_PRUNE_INTERVAL_MS);
  if (typeof jobsPruneTimer.unref === 'function') jobsPruneTimer.unref();
}

function stopJobsPruner(): void {
  if (jobsPruneTimer) {
    clearInterval(jobsPruneTimer);
    jobsPruneTimer = null;
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  stopStallDetector();
  stopJobsPruner();
  closeCache();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
try {
  initDb();
  initCache();
  initJobsStore();
  initSigning();

  // Reset jobs/runs orphaned by an unclean shutdown so the worker pool
  // re-enqueues them. (Task #16: restart resilience)
  const swept = sweepStaleRunning();
  if (swept.jobs > 0 || swept.runs > 0) {
    logger.info(swept, 'Reset stale running jobs/runs from previous process');
  }

  // Re-enqueue any pending jobs (from this boot's sweep + jobs created in a
  // previous process that never got picked up).
  resumePending();
  startStallDetector();
  startJobsPruner();

  app.listen(config.PORT, () => {
    logger.info(`Verify Sidecar running at http://localhost:${config.PORT}`);
  });
} catch (error) {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
}
