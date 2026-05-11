import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_URL: 'http://localhost:9999',
    GATEWAY_TIMEOUT_MS: 5_000,
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_WORKER_CONCURRENCY: 2,
    JOB_STALL_MS: 1,
    JOB_STALL_CHECK_INTERVAL_MS: 60_000,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
let workerModule: typeof import('../../src/pipeline/job-worker.js') | null = null;

try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  jobsModule = await import('../../src/storage/jobs.js');
  workerModule = await import('../../src/pipeline/job-worker.js');
} catch {
  // sqlite native binding unavailable
}

const describeIfAvailable = workerModule ? describe : describe.skip;

describeIfAvailable('terminal-state race safety', () => {
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

  it('stall detector skips emission when the worker has already completed the run', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const run = jobsModule!.startRun(job.id);

    // Simulate the worker completing the run JUST before the stall sweep.
    jobsModule!.completeRun(run.id, null);
    expect(jobsModule!.getRun(run.id)!.status).toBe('completed');

    // Stall detector now wakes — last_progress_at is older than JOB_STALL_MS=1
    // so findStalledRuns would return this run (status='running' filter would
    // not — but the bug we're checking is: even if it DID pick it up, failRun
    // is status-conditional and would return false. Force the race window by
    // resetting the run row to look running-but-stale, then calling
    // checkStalledOnce.
    dbModule!
      .getDb()
      .prepare(`UPDATE job_runs SET status = 'running', last_progress_at = ? WHERE id = ?`)
      .run(Date.now() - 1_000, run.id);
    // Worker writes their completion (race winner). After this, run is back to 'completed'.
    dbModule!.getDb().prepare(`UPDATE job_runs SET status = 'completed' WHERE id = ?`).run(run.id);

    // Now call checkStalledOnce — it will see no stalled runs because the
    // filter is `WHERE status='running'`. So the detector should find zero
    // and emit nothing.
    const failed = workerModule!.checkStalledOnce();
    expect(failed).toBe(0);

    // No run.failed event should have been emitted.
    const events = jobsModule!.listEventsForTenant('tenant_a').items;
    expect(events.filter((e) => e.type === 'run.failed').length).toBe(0);
  });

  it('worker skips run.completed emission when the run was already finalized', () => {
    // Hand-roll the worker's terminal-transition sequence to prove the gate
    // works without spinning up the full async worker.
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: [] },
      totalCount: 0,
    });
    const run = jobsModule!.startRun(job.id);

    // Stall detector wins the race first.
    expect(jobsModule!.failRun(run.id, 'stalled')).toBe(true);
    jobsModule!.recordEvent({
      tenantId: job.tenantId,
      jobId: job.id,
      runId: run.id,
      type: 'run.failed',
      payload: { reason: 'stalled' },
    });

    // Worker then tries to complete — must be a no-op at the DB level.
    expect(jobsModule!.completeRun(run.id, null)).toBe(false);

    // The end state is the stall detector's: run.status='failed', exactly one
    // 'run.failed' event, no 'run.completed' event.
    expect(jobsModule!.getRun(run.id)!.status).toBe('failed');
    const events = jobsModule!.listEventsForTenant('tenant_a').items;
    expect(events.filter((e) => e.type === 'run.failed').length).toBe(1);
    expect(events.filter((e) => e.type === 'run.completed').length).toBe(0);
  });
});
