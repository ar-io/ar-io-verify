import { describe, it, expect } from 'vitest';
import { canonicalize } from '../src/canonical.mjs';
import { merkleRootFromCanonicalEntries } from '../src/merkle.mjs';
import { reverifyBundle } from '../src/reverify.mjs';
import { createHash } from 'node:crypto';

function b64url(buf) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Build a minimal-but-valid V2 bundle skeleton in-test, so the verifier
// CLI exercises the full pipeline without depending on the server.
function makeBundle({ verified = [], failed = [] } = {}) {
  const merkleLeaves = [
    ...verified.map((v) => canonicalize(v)),
    ...failed.map((f) => canonicalize(f)),
  ];
  const txMerkleRoot = merkleRootFromCanonicalEntries(merkleLeaves);

  const unsigned = {
    $schema: 'https://verify.ar.io/schemas/v2/bundle.json',
    '@context': 'https://verify.ar.io/contexts/v2',
    type: 'VerificationBundle',
    version: 2,
    id: 'urn:ar-io-verify:job_test:run_test',
    jobId: 'job_test',
    runId: 'run_test',
    tenantId: 'tenant_test',
    issuer: {
      operator: null,
      operatorPublicKey: null,
      gateway: { host: 'g.test', url: null, softwareVersion: '0.3.0' },
      trustAnchor: 'self-asserted-arweave-wallet',
      independence: 'third-party-from-data-owner',
    },
    subject: {
      input: { type: 'txIds', ids: [...verified.map((v) => v.txId), ...failed.map((f) => f.txId)] },
      network: 'arweave-mainnet',
      totalCount: verified.length + failed.length,
    },
    methodology: {
      checks: ['existence', 'data_hash_sha256', 'signature_deep_hash'],
      signatureAlgorithms: ['RSA-PSS-SHA256'],
      deepHashSpec: 'ANS-104',
      canonicalization: 'RFC8785',
      assuranceLevel: 'cryptographic-proof',
      knownLimitations: [],
      referenceVerifier: 'https://example/',
    },
    results: {
      verified,
      failed,
      verifiedTruncated: false,
      failuresTruncated: false,
      txMerkleRoot,
      totals: {
        verified: verified.length,
        tampered: failed.filter((f) => f.outcome === 'tampered').length,
        unavailable: failed.filter((f) => f.outcome === 'unavailable').length,
        cacheHit: 0,
        bytesFetched: 0,
        total: verified.length + failed.length,
      },
    },
    validity: {
      producedAt: '2026-05-14T00:00:00.000Z',
      validFrom: '2026-05-14T00:00:00.000Z',
      validUntil: '2026-11-14T00:00:00.000Z',
      retentionPolicy: 'P6M',
      timeSource: 'system-clock',
    },
    humanReadable: {
      summary: 'Test bundle summary that is long enough to satisfy the schema rules here.',
      limitations: 'Test bundle limitations text that is long enough to satisfy schema rules.',
      howToReverify: 'Test bundle reverify hint that is long enough to satisfy schema rules.',
    },
    conformance: ['rfc-8785-canonical-json'],
    signatureAlgorithm: 'RSA-PSS-SHA256',
  };

  const canonical = canonicalize(unsigned);
  const payloadHash = b64url(createHash('sha256').update(canonical, 'utf8').digest());
  return { ...unsigned, payloadHash, signature: null };
}

describe('verifier-cli reverify', () => {
  it('PASSes payloadHash + Merkle on a synthesized empty bundle', () => {
    const b = makeBundle();
    const r = reverifyBundle(b);
    expect(r.steps.find((s) => s.name.includes('payloadHash')).ok).toBe(true);
    expect(r.steps.find((s) => s.name.includes('txMerkleRoot')).ok).toBe(true);
    // signature step fails honestly — bundle is unsigned
    expect(r.steps.find((s) => s.name.includes('signature verifies')).ok).toBe(false);
    expect(r.ok).toBe(false); // overall PASS requires signature too
  });

  it('PASSes payloadHash + Merkle on a bundle with verified + failed rows', () => {
    const verified = [
      {
        txId: 'tx_pass_1',
        level: 3,
        dataSha256: 'aaa',
        owner: 'owner_x',
        blockHeight: 100,
        blockTimestamp: '2026-01-01T00:00:00Z',
        signatureType: null,
        isBundled: false,
        bundleRootTxId: null,
        recovery: { arweave: { txId: 'tx_pass_1', weaveSize: 10, weaveOffset: 999 }, dataItem: null },
        verificationId: 'v1',
      },
    ];
    const failed = [
      { txId: 'tx_fail_1', outcome: 'unavailable', failureReason: 'gateway_404', verificationId: null },
    ];
    const b = makeBundle({ verified, failed });
    const r = reverifyBundle(b);
    expect(r.steps.find((s) => s.name.includes('payloadHash')).ok).toBe(true);
    expect(r.steps.find((s) => s.name.includes('txMerkleRoot')).ok).toBe(true);
  });

  it('FAILs payloadHash when a field is tampered', () => {
    const b = makeBundle();
    b.tenantId = 'tenant_mallory'; // tamper after hashing
    const r = reverifyBundle(b);
    expect(r.steps.find((s) => s.name.includes('payloadHash')).ok).toBe(false);
  });

  it('FAILs Merkle when a verified row is tampered', () => {
    const verified = [
      {
        txId: 'tx_pass_1',
        level: 3,
        dataSha256: 'aaa',
        owner: 'owner_x',
        blockHeight: 100,
        blockTimestamp: '2026-01-01T00:00:00Z',
        signatureType: null,
        isBundled: false,
        bundleRootTxId: null,
        recovery: { arweave: null, dataItem: null },
        verificationId: 'v1',
      },
    ];
    const b = makeBundle({ verified });
    // Mutate AFTER bundle is built — Merkle root won't match canonical entries.
    b.results.verified[0].owner = 'owner_mallory';
    const r = reverifyBundle(b);
    expect(r.steps.find((s) => s.name.includes('txMerkleRoot')).ok).toBe(false);
  });

  it('FAILs shape when version != 2', () => {
    const b = makeBundle();
    b.version = 1;
    const r = reverifyBundle(b);
    expect(r.steps[0].ok).toBe(false);
  });
});
