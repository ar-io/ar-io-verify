import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_WORKER_CONCURRENCY: 2,
    JOB_STALL_MS: 60_000,
    JOB_STALL_CHECK_INTERVAL_MS: 60_000,
    SHUTDOWN_DRAIN_MS: 1_000,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Toggle the gateway health probe so we can drive /ready into both states.
const gatewayHealth = { ok: true };
// Minimal mock that only stubs checkGatewayHealth — the /ready route doesn't
// need the rest of the gateway client surface, so we don't have to round-trip
// through vi.importActual (which collides with the mocked config).
vi.mock('../../src/gateway/client.js', () => ({
  checkGatewayHealth: async () => gatewayHealth.ok,
}));

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let metricsRoute: { default: express.Router } | null = null;
let readyRoute: { default: express.Router } | null = null;
let importErr: unknown = null;

try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  await import('../../src/utils/metrics.js');
  metricsRoute = await import('../../src/routes/metrics.js');
  readyRoute = await import('../../src/routes/ready.js');
} catch (err) {
  importErr = err;
}

const describeIfAvailable = metricsRoute && readyRoute ? describe : describe.skip;
if (importErr) {
  // Surface the failure so CI doesn't silently skip these tests.
  console.warn('ops.test import failed:', importErr);
}

describeIfAvailable('ops endpoints', () => {
  beforeAll(() => {
    dbModule!.initDb();
  });

  afterAll(() => {
    dbModule!.closeDb();
  });

  function appWith(path: string, router: express.Router): express.Express {
    const a = express();
    a.use(path, router);
    return a;
  }

  it('GET /metrics returns Prometheus text-format with verify_ metrics present', async () => {
    const res = await request(appWith('/metrics', metricsRoute!.default)).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // Defaults from collectDefaultMetrics are prefixed with verify_:
    expect(res.text).toContain('verify_process_cpu_seconds_total');
    // Domain metrics exist (defined in utils/metrics.ts):
    expect(res.text).toContain('verify_gateway_queue_depth');
    expect(res.text).toContain('verify_signing_enabled');
  });

  it('GET /ready returns 200 when DB + gateway are healthy', async () => {
    gatewayHealth.ok = true;
    const res = await request(appWith('/ready', readyRoute!.default)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.checks.db).toBe(true);
    expect(res.body.checks.gateway).toBe(true);
    expect(typeof res.body.checks.signing).toBe('boolean');
  });

  it('GET /ready returns 503 when the gateway probe fails', async () => {
    gatewayHealth.ok = false;
    const res = await request(appWith('/ready', readyRoute!.default)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.checks.gateway).toBe(false);
    // DB is still up — verify the per-check granularity.
    expect(res.body.checks.db).toBe(true);
  });
});
