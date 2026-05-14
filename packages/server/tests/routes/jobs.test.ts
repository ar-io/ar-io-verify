import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { VerificationResult } from '../../src/types.js';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    JOB_WORKER_CONCURRENCY: 2,
    GATEWAY_MAX_INFLIGHT: 32,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Mock the verification pipeline so HTTP tests run without network.
vi.mock('../../src/pipeline/orchestrator.js', () => ({
  runVerification: async ({ txId }: { txId: string }) => makeResult(txId),
}));

function makeResult(txId: string): VerificationResult {
  const result: VerificationResult = {
    verificationId: `vrf_${txId}`,
    timestamp: new Date().toISOString(),
    txId,
    level: 3,
    existence: { status: 'confirmed', blockHeight: 100, blockTimestamp: null, blockId: null },
    authenticity: {
      status: 'signature_verified',
      signatureValid: true,
      signatureSkipReason: null,
      dataHash: 'h',
      gatewayHash: 'h',
      hashMatch: true,
    },
    owner: { address: 'addr', publicKey: null, addressVerified: true },
    metadata: { dataSize: 100, contentType: null, tags: [] },
    bundle: { isBundled: false, rootTransactionId: null },
    recovery: { arweave: null, dataItem: null },
    gatewayAssessment: { verified: null, stable: null, trusted: null, hops: null },
    attestation: null,
    links: { dashboard: null, pdf: null, rawData: null },
  };
  return result;
}

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
let cacheModule: typeof import('../../src/storage/cache.js') | null = null;
let workerModule: typeof import('../../src/pipeline/job-worker.js') | null = null;
let routesModule: { default: express.Router } | null = null;

try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  jobsModule = await import('../../src/storage/jobs.js');
  cacheModule = await import('../../src/storage/cache.js');
  workerModule = await import('../../src/pipeline/job-worker.js');
  routesModule = await import('../../src/routes/jobs.js');
} catch {
  // sqlite native binding unavailable
}

const describeIfAvailable = routesModule ? describe : describe.skip;

const TX_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/jobs', routesModule!.default);
  return app;
}

describeIfAvailable('jobs HTTP routes', () => {
  beforeAll(() => {
    dbModule!.initDb();
    jobsModule!.initJobsStore();
    cacheModule!.initCache();
  });

  afterAll(() => {
    cacheModule!.closeCache();
    dbModule!.closeDb();
  });

  beforeEach(() => {
    const db = dbModule!.getDb();
    db.exec(
      'DELETE FROM job_events; DELETE FROM verification_bundles; DELETE FROM job_results; DELETE FROM job_runs; DELETE FROM jobs; DELETE FROM verification_results;'
    );
  });

  it('POST /jobs creates a job and returns 202', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(/^job_/);
    expect(res.body.status).toBe('pending');
    expect(res.body.deduplicated).toBe(false);
  });

  it('POST /jobs validates txId format', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: ['too-short'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('POST /jobs honors Idempotency-Key per-tenant', async () => {
    const app = buildApp();
    const first = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .set('Idempotency-Key', 'foo')
      .send({ txIds: [TX_A] });
    const second = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .set('Idempotency-Key', 'foo')
      .send({ txIds: [TX_B] });
    expect(first.body.jobId).toBe(second.body.jobId);
    expect(second.body.deduplicated).toBe(true);
  });

  it('POST /jobs Idempotency-Key does not collide across tenants', async () => {
    const app = buildApp();
    const a = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .set('Idempotency-Key', 'shared')
      .send({ txIds: [TX_A] });
    const b = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_b')
      .set('Idempotency-Key', 'shared')
      .send({ txIds: [TX_A] });
    expect(a.body.jobId).not.toBe(b.body.jobId);
  });

  it('GET /jobs/:id returns 404 for cross-tenant access (no leak)', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    const wrong = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}`)
      .set('X-Tenant-Id', 'tenant_b');
    expect(wrong.status).toBe(404);
    const right = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(right.status).toBe(200);
    expect(right.body.job.id).toBe(created.body.jobId);
  });

  it('GET /jobs/:id status reflects counters after worker run', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A, TX_B] });
    // Drive the job synchronously through the worker (the route fires-and-forgets).
    await workerModule!.runJob(created.body.jobId);

    const status = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(status.body.job.status).toBe('completed');
    expect(status.body.run.counters.verified).toBe(2);
  });

  it('GET /jobs/:id/results paginates and filters by outcome', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A, TX_B] });
    await workerModule!.runJob(created.body.jobId);

    const all = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}/results`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(all.body.items.length).toBe(2);

    const tampered = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}/results?outcome=tampered`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(tampered.body.items.length).toBe(0);
  });

  it('DELETE /jobs/:id cancels a pending job', async () => {
    const app = buildApp();
    // Create the job directly via the repo to avoid the route's fire-and-forget
    // enqueue racing the cancel — the mocked verifier completes instantly.
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [TX_A] },
      totalCount: 1,
    });
    const cancel = await request(app)
      .delete(`/api/v1/jobs/${job.id}`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect(jobsModule!.findJobById(job.id)!.status).toBe('cancelled');

    // Cross-tenant cancel attempt = 404
    const stranger = await request(app)
      .delete(`/api/v1/jobs/${job.id}`)
      .set('X-Tenant-Id', 'tenant_b');
    expect(stranger.status).toBe(404);
  });

  it('DELETE /jobs/:id returns 409 if already terminal', async () => {
    const app = buildApp();
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [TX_A] },
      totalCount: 1,
    });
    jobsModule!.updateJobStatus(job.id, 'completed');
    const res = await request(app).delete(`/api/v1/jobs/${job.id}`).set('X-Tenant-Id', 'tenant_a');
    expect(res.status).toBe(409);
    expect(res.body.status).toBe('completed');
  });

  it('GET /jobs/events returns tenant-scoped events from worker runs', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    await workerModule!.runJob(created.body.jobId);

    const aEvents = await request(app).get('/api/v1/jobs/events').set('X-Tenant-Id', 'tenant_a');
    expect(aEvents.body.items.length).toBe(1);
    expect(aEvents.body.items[0].type).toBe('run.completed');

    const bEvents = await request(app).get('/api/v1/jobs/events').set('X-Tenant-Id', 'tenant_b');
    expect(bEvents.body.items.length).toBe(0);
  });

  it('GET /jobs/events with since cursor advances stream', async () => {
    const app = buildApp();
    const j1 = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    await workerModule!.runJob(j1.body.jobId);
    const j2 = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_B] });
    await workerModule!.runJob(j2.body.jobId);

    const first = await request(app)
      .get('/api/v1/jobs/events?limit=1')
      .set('X-Tenant-Id', 'tenant_a');
    expect(first.body.items.length).toBe(1);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`/api/v1/jobs/events?limit=1&since=${first.body.nextCursor}`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(second.body.items.length).toBe(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it('GET /jobs/:id/report returns signed bundle JSON after worker run', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    await workerModule!.runJob(created.body.jobId);

    const report = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}/report`)
      .set('X-Tenant-Id', 'tenant_a')
      .set('Accept', 'application/json');
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('application/json');
    expect(report.headers['content-disposition']).toContain('verify-bundle-');
    const parsed = JSON.parse(report.text);
    expect(parsed.type).toBe('VerificationBundle');
    expect(parsed.version).toBe(2);
    expect(parsed.tenantId).toBe('tenant_a');
    expect(parsed.results.totals.verified).toBe(1);
    expect(parsed.methodology.canonicalization).toBe('RFC8785');
    expect(parsed.validity.retentionPolicy).toBe('P6M');
  });

  it('GET /jobs/:id/report 404s before the run completes', async () => {
    const app = buildApp();
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [TX_A] },
      totalCount: 1,
    });
    const res = await request(app)
      .get(`/api/v1/jobs/${job.id}/report`)
      .set('X-Tenant-Id', 'tenant_a');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_completed_run');
  });

  it('GET /jobs/:id/report enforces tenant scoping', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    await workerModule!.runJob(created.body.jobId);

    const wrong = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}/report`)
      .set('X-Tenant-Id', 'tenant_b');
    expect(wrong.status).toBe(404);
  });

  it('GET /jobs/:id/report with Accept: application/pdf returns 406 (not yet implemented)', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/v1/jobs')
      .set('X-Tenant-Id', 'tenant_a')
      .send({ txIds: [TX_A] });
    await workerModule!.runJob(created.body.jobId);

    const res = await request(app)
      .get(`/api/v1/jobs/${created.body.jobId}/report`)
      .set('X-Tenant-Id', 'tenant_a')
      .set('Accept', 'application/pdf');
    expect(res.status).toBe(406);
  });

  it('rejects requests with no tenant header in production mode', async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/jobs')
        .send({ txIds: [TX_A] });
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = old;
    }
  });
});
