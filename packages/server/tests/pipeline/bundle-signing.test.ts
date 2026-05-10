import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  verify as cryptoVerify,
  constants as cryptoConstants,
} from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Generate a real keypair, write JWK to a temp file, then mock config to
// point at it. This is the only place we exercise the operator-wallet
// signing path end-to-end so the canonical-JSON contract is genuinely
// verifiable from outside the codebase.
const tmpDir = mkdtempSync(join(tmpdir(), 'verify-sign-test-'));
const keyPath = join(tmpDir, 'wallet.jwk');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateJwk = privateKey.export({ format: 'jwk' });
writeFileSync(keyPath, JSON.stringify(privateJwk));

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_HOST: 'gateway.test',
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_WORKER_CONCURRENCY: 2,
    SIGNING_KEY_PATH: keyPath,
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

describeIfAvailable('bundle signing — operator-wallet round-trip', () => {
  beforeAll(() => {
    dbModule!.initDb();
    jobsModule!.initJobsStore();
    const ok = signingModule!.initSigning();
    expect(ok).toBe(true);
    expect(signingModule!.isSigningEnabled()).toBe(true);
  });

  afterAll(() => {
    dbModule!.closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('signed bundle verifies offline using the operator public key (RSA-PSS)', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1', 't2'] },
      totalCount: 2,
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
    jobsModule!.bumpRunCounters(run.id, { verified: 1, failed: 1 });
    jobsModule!.completeRun(run.id, null);

    const bundle = bundleModule!.buildBundle(job.id, run.id)!;
    expect(bundle.signature).not.toBeNull();
    expect(bundle.operator).not.toBeNull();
    expect(bundle.operatorPublicKey).not.toBeNull();

    // Reconstruct the signed bytes the way an external verifier would:
    // strip signature + payloadHash, deep-canonicalize, hash → matches payloadHash.
    const { signature, payloadHash, ...unsigned } = bundle;
    const canonical = signingModule!.canonicalize(unsigned as unknown as Record<string, unknown>);
    const sigBuf = Buffer.from(signature!, 'base64url');

    // Verify using the public key the bundle claims to belong to. The whole
    // value of the bundle is that this verification needs nothing from the
    // verify server — only the operator's public key.
    const claimedPubKey = createPublicKey({
      key: { kty: 'RSA', n: bundle.operatorPublicKey!, e: 'AQAB' },
      format: 'jwk',
    });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(canonical),
      {
        key: claimedPubKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_AUTO,
      },
      sigBuf
    );
    expect(ok).toBe(true);

    // Sanity: the same signature must NOT verify under a different keypair.
    const { publicKey: otherPub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherOk = cryptoVerify(
      'sha256',
      Buffer.from(canonical),
      {
        key: otherPub,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_AUTO,
      },
      sigBuf
    );
    expect(otherOk).toBe(false);

    // Sanity: tampering with the canonical bytes invalidates the signature.
    const tamperedCanonical = canonical.replace(/"verified":1/, '"verified":99');
    expect(tamperedCanonical).not.toBe(canonical);
    const tamperedOk = cryptoVerify(
      'sha256',
      Buffer.from(tamperedCanonical),
      {
        key: claimedPubKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_AUTO,
      },
      sigBuf
    );
    expect(tamperedOk).toBe(false);
  });
});

// Suppress the unused "publicKey" so node's keypair generation isn't dead.
void publicKey;
