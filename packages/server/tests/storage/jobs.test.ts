import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  jobsModule = await import('../../src/storage/jobs.js');
} catch {
  dbModule = null;
  jobsModule = null;
}

const describeIfAvailable = jobsModule ? describe : describe.skip;

describeIfAvailable('jobs store', () => {
  beforeAll(() => {
    dbModule!.initDb();
    jobsModule!.initJobsStore();
  });

  afterAll(() => {
    dbModule!.closeDb();
  });

  beforeEach(() => {
    const db = dbModule!.getDb();
    db.exec(
      'DELETE FROM job_events; DELETE FROM verification_bundles; DELETE FROM job_results; DELETE FROM job_runs; DELETE FROM jobs;'
    );
  });

  it('creates a job and dedups on idempotency key within a tenant', () => {
    const a = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: 'idem-1',
      inputType: 'txIds',
      inputSpec: { ids: ['t1', 't2'] },
      totalCount: 2,
    });
    expect(a.deduplicated).toBe(false);
    expect(a.job.status).toBe('pending');

    const b = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: 'idem-1',
      inputType: 'txIds',
      inputSpec: { ids: ['t9'] },
      totalCount: 1,
    });
    expect(b.deduplicated).toBe(true);
    expect(b.job.id).toBe(a.job.id);
  });

  it('idempotency keys do not collide across tenants', () => {
    const a = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: 'shared-key',
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const b = jobsModule!.createJob({
      tenantId: 'tenant_b',
      idempotencyKey: 'shared-key',
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(false);
    expect(a.job.id).not.toBe(b.job.id);
  });

  it('findJobOwnedByTenant enforces tenancy', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    expect(jobsModule!.findJobOwnedByTenant(job.id, 'tenant_a')).not.toBeNull();
    expect(jobsModule!.findJobOwnedByTenant(job.id, 'tenant_b')).toBeNull();
  });

  it('records run lifecycle and counter bumps', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1', 't2', 't3'] },
      totalCount: 3,
    });
    const run = jobsModule!.startRun(job.id);
    expect(run.status).toBe('running');

    jobsModule!.bumpRunCounters(run.id, { verified: 1, cacheHit: 1, bytesFetched: 100 });
    jobsModule!.bumpRunCounters(run.id, { verified: 1, bytesFetched: 200 });
    jobsModule!.bumpRunCounters(run.id, { failed: 1 });

    const after = jobsModule!.getRun(run.id)!;
    expect(after.verifiedCount).toBe(2);
    expect(after.failedCount).toBe(1);
    expect(after.cacheHitCount).toBe(1);
    expect(after.bytesFetched).toBe(300);

    jobsModule!.completeRun(run.id, null);
    expect(jobsModule!.getRun(run.id)!.status).toBe('completed');
  });

  it('lists results, filters by outcome, and paginates', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [] },
      totalCount: 0,
    });
    const run = jobsModule!.startRun(job.id);

    for (let i = 0; i < 5; i++) {
      jobsModule!.recordResult({
        jobRunId: run.id,
        txId: `t${i}`,
        verificationId: `vrf_${i}`,
        outcome: i % 2 === 0 ? 'verified' : 'tampered',
        cacheHit: false,
        failureReason: i % 2 === 0 ? null : 'signature_mismatch',
      });
    }

    const tampered = jobsModule!.listResults(run.id, { outcome: 'tampered' });
    expect(tampered.items.length).toBe(2);
    expect(tampered.items.every((r) => r.outcome === 'tampered')).toBe(true);

    const firstPage = jobsModule!.listResults(run.id, { limit: 2 });
    expect(firstPage.items.length).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = jobsModule!.listResults(run.id, {
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.length).toBe(2);
    expect(secondPage.items[0].txId).not.toBe(firstPage.items[0].txId);
  });

  it('getCompletedTxIds returns set of recorded txIds for resume', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [] },
      totalCount: 0,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 'tx_done',
      verificationId: 'v1',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });
    const done = jobsModule!.getCompletedTxIds(run.id);
    expect(done.has('tx_done')).toBe(true);
    expect(done.has('tx_other')).toBe(false);
  });

  it('records and lists events scoped to a tenant', () => {
    const { job: jobA } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [] },
      totalCount: 0,
    });
    const { job: jobB } = jobsModule!.createJob({
      tenantId: 'tenant_b',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [] },
      totalCount: 0,
    });
    jobsModule!.recordEvent({
      tenantId: 'tenant_a',
      jobId: jobA.id,
      runId: null,
      type: 'run.completed',
      payload: { totals: { verified: 5 } },
    });
    jobsModule!.recordEvent({
      tenantId: 'tenant_b',
      jobId: jobB.id,
      runId: null,
      type: 'run.failed',
      payload: { reason: 'gateway_timeout' },
    });

    const aEvents = jobsModule!.listEventsForTenant('tenant_a');
    expect(aEvents.items.length).toBe(1);
    expect(aEvents.items[0].type).toBe('run.completed');
    expect(aEvents.items[0].payload.totals).toEqual({ verified: 5 });

    const bEvents = jobsModule!.listEventsForTenant('tenant_b');
    expect(bEvents.items.length).toBe(1);
    expect(bEvents.items[0].type).toBe('run.failed');
  });

  it('sweepStaleRunning resets in-flight jobs and runs after a crash', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    jobsModule!.updateJobStatus(job.id, 'running');
    const run = jobsModule!.startRun(job.id);

    const swept = jobsModule!.sweepStaleRunning();
    expect(swept.jobs).toBeGreaterThanOrEqual(1);
    expect(swept.runs).toBeGreaterThanOrEqual(1);

    expect(jobsModule!.findJobById(job.id)!.status).toBe('pending');
    expect(jobsModule!.getRun(run.id)!.status).toBe('failed');
  });

  it('saves and retrieves a verification bundle by run id', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [] },
      totalCount: 0,
    });
    const run = jobsModule!.startRun(job.id);
    const bundle = jobsModule!.saveBundle(run.id, '{"version":1,"jobId":"foo"}');
    const fetched = jobsModule!.getBundleByRunId(run.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(bundle.id);
    expect(fetched!.bundleJson).toContain('"version":1');
  });
});
