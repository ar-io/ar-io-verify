import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initCache, saveResult, getResultById, getResultsByTxId, closeCache } from '../../src/storage/cache.js';
import type { VerificationResult } from '../../src/types.js';

// Override config to use in-memory SQLite
import { vi } from 'vitest';
vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

function makeResult(id: string, txId: string): VerificationResult {
  return {
    verificationId: id,
    timestamp: new Date().toISOString(),
    txId,
    level: 3,
    existence: { status: 'confirmed', blockHeight: 100, blockTimestamp: null, blockId: null, confirmations: null },
    authenticity: { status: 'signature_verified', signatureValid: true, signatureSkipReason: null, dataHash: 'hash', gatewayHash: 'hash', hashMatch: true },
    owner: { address: 'addr', publicKey: null, addressVerified: true },
    metadata: { dataSize: 100, contentType: 'text/plain', tags: [] },
    bundle: { isBundled: false, rootTransactionId: null },
    gatewayAssessment: { verified: null, stable: null, trusted: null, hops: null },
    links: { dashboard: null, pdf: null, rawData: null },
  };
}

describe('Cache', () => {
  beforeAll(() => {
    initCache();
  });

  afterAll(() => {
    closeCache();
  });

  it('saves and retrieves a result by ID', () => {
    const result = makeResult('vrf_test1', 'tx1_padded_to_43_chars_12345678901234567');
    saveResult(result);

    const retrieved = getResultById('vrf_test1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.verificationId).toBe('vrf_test1');
    expect(retrieved!.level).toBe(3);
  });

  it('returns null for unknown ID', () => {
    const result = getResultById('vrf_nonexistent');
    expect(result).toBeNull();
  });

  it('retrieves multiple results by txId', () => {
    const txId = 'tx2_padded_to_43_chars_12345678901234567';
    saveResult(makeResult('vrf_a', txId));
    saveResult(makeResult('vrf_b', txId));

    const results = getResultsByTxId(txId);
    expect(results.length).toBe(2);
  });
});
