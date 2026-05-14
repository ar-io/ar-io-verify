import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_HOST: 'gateway.test',
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_WORKER_CONCURRENCY: 2,
    SIGNING_KEY_PATH: '',
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
let bundleModule: typeof import('../../src/pipeline/bundle.js') | null = null;
let signingModule: typeof import('../../src/utils/signing.js') | null = null;

try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  jobsModule = await import('../../src/storage/jobs.js');
  bundleModule = await import('../../src/pipeline/bundle.js');
  signingModule = await import('../../src/utils/signing.js');
} catch {
  // sqlite native binding unavailable
}

const describeIfAvailable = bundleModule ? describe : describe.skip;

describeIfAvailable('verification bundle', () => {
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

  it('builds a bundle with totals, gateway, and tenancy metadata', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1', 't2', 't3'] },
      totalCount: 3,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't1',
      verificationId: 'v1',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't2',
      verificationId: 'v2',
      outcome: 'tampered',
      cacheHit: false,
      failureReason: 'signature_mismatch',
    });
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't3',
      verificationId: null,
      outcome: 'unavailable',
      cacheHit: false,
      failureReason: 'gateway_404',
    });
    jobsModule!.bumpRunCounters(run.id, { verified: 1, failed: 1, unavailable: 1 });
    jobsModule!.completeRun(run.id, null);

    const bundle = bundleModule!.buildBundle(job.id, run.id)!;
    expect(bundle.version).toBe(2);
    expect(bundle.type).toBe('VerificationBundle');
    expect(bundle.tenantId).toBe('tenant_a');
    expect(bundle.issuer.gateway.host).toBe('gateway.test');
    expect(bundle.results.totals.verified).toBe(1);
    expect(bundle.results.totals.tampered).toBe(1);
    expect(bundle.results.totals.unavailable).toBe(1);
    expect(bundle.results.totals.total).toBe(3);
    expect(bundle.results.failed.length).toBe(2); // tampered + unavailable
    expect(bundle.results.failuresTruncated).toBe(false);
    expect(bundle.methodology.canonicalization).toBe('RFC8785');
    expect(bundle.validity.retentionPolicy).toBe('P6M');
    expect(bundle.conformance).toContain('eu-ai-act-art-10-12-13-19-aligned');
    expect(bundle.humanReadable.summary).toContain('1 of 3 transactions');
    // No wallet configured → null signature, but payloadHash always present
    expect(bundle.signature).toBeNull();
    expect(bundle.payloadHash).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(bundle.signatureAlgorithm).toBe('RSA-PSS-SHA256');
  });

  it('canonical JSON is byte-identical across re-builds for the same run', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't1',
      verificationId: 'v1',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });
    jobsModule!.bumpRunCounters(run.id, { verified: 1 });
    jobsModule!.completeRun(run.id, null);

    const a = bundleModule!.bundleToCanonicalJson(bundleModule!.buildBundle(job.id, run.id)!);
    const b = bundleModule!.bundleToCanonicalJson(bundleModule!.buildBundle(job.id, run.id)!);
    expect(a).toBe(b);
  });

  it('payloadHash matches independent SHA-256 of canonical bundle minus payloadHash and signature', async () => {
    const { createHash } = await import('node:crypto');
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.bumpRunCounters(run.id, { verified: 1 });
    jobsModule!.completeRun(run.id, null);

    const bundle = bundleModule!.buildBundle(job.id, run.id)!;
    const { payloadHash, signature, ...unsigned } = bundle;
    const canonical = signingModule!.canonicalize(unsigned as unknown as Record<string, unknown>);
    const expectedHash = createHash('sha256').update(canonical).digest('base64url');
    expect(payloadHash).toBe(expectedHash);
    expect(signature).toBeNull(); // no wallet in this test
  });

  it('caps failures at 1000 and sets failuresTruncated when there are more', () => {
    const ids = Array.from({ length: 1100 }, (_, i) => `tx_${i.toString().padStart(4, '0')}`);
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids },
      totalCount: ids.length,
    });
    const run = jobsModule!.startRun(job.id);
    for (const id of ids) {
      jobsModule!.recordResult({
        jobRunId: run.id,
        txId: id,
        verificationId: null,
        outcome: 'tampered',
        cacheHit: false,
        failureReason: 'signature_mismatch',
      });
    }
    jobsModule!.bumpRunCounters(run.id, { failed: 1100 });
    jobsModule!.completeRun(run.id, null);

    const bundle = bundleModule!.buildBundle(job.id, run.id)!;
    expect(bundle.results.failed.length).toBe(1000);
    expect(bundle.results.failuresTruncated).toBe(true);
    // The totals still reflect the real count — the cap is only on the
    // embedded list. Customers retrieve the rest via /jobs/:id/results.
    expect(bundle.results.totals.tampered).toBe(1100);
    // Merkle root binds the embedded entries even when truncated.
    expect(bundle.results.txMerkleRoot).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null when the run does not exist', () => {
    expect(bundleModule!.buildBundle('job_nope', 'run_nope')).toBeNull();
  });

  it('V2 carries all compliance-anchor fields (EU AI Act, VC 2.0, C2PA, RFC 8785)', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.bumpRunCounters(run.id, { verified: 1 });
    jobsModule!.completeRun(run.id, null);
    const bundle = bundleModule!.buildBundle(job.id, run.id)!;

    // VC 2.0 structural conventions
    expect(bundle['$schema']).toBe('https://verify.ar.io/schemas/v2/bundle.json');
    expect(bundle['@context']).toBe('https://verify.ar.io/contexts/v2');
    expect(bundle.id).toMatch(/^urn:ar-io-verify:/);
    expect(bundle.issuer.trustAnchor).toBe('self-asserted-arweave-wallet');
    expect(bundle.issuer.independence).toBe('third-party-from-data-owner');

    // EU AI Act Art. 19 — retention floor
    expect(bundle.validity.retentionPolicy).toBe('P6M');
    expect(bundle.validity.timeSource).toBe('system-clock');
    expect(new Date(bundle.validity.validUntil).getTime()).toBeGreaterThan(
      new Date(bundle.validity.validFrom).getTime()
    );

    // EU AI Act Art. 13 — plain-language transparency
    expect(bundle.humanReadable.summary.length).toBeGreaterThan(20);
    expect(bundle.humanReadable.limitations.length).toBeGreaterThan(20);
    expect(bundle.humanReadable.howToReverify).toContain('reverify');

    // Methodology + reproducibility
    expect(bundle.methodology.canonicalization).toBe('RFC8785');
    expect(bundle.methodology.assuranceLevel).toBe('cryptographic-proof');
    expect(bundle.methodology.referenceVerifier).toContain('verifier-cli');

    // Conformance assertions
    expect(bundle.conformance).toContain('eu-ai-act-art-10-12-13-19-aligned');
    expect(bundle.conformance).toContain('vc-2.0-structural');
    expect(bundle.conformance).toContain('c2pa-2.x-aligned');
    expect(bundle.conformance).toContain('rfc-8785-canonical-json');

    // Tamper-evidence
    expect(bundle.signatureAlgorithm).toBe('RSA-PSS-SHA256');
    expect(bundle.results.txMerkleRoot).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
