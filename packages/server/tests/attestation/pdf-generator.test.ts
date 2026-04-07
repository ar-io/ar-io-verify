import { describe, it, expect } from 'vitest';
import { generatePdf } from '../../src/attestation/pdf-generator.js';
import type { VerificationResult } from '../../src/types.js';

function makeResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    verificationId: 'vrf_test123456789',
    timestamp: '2024-01-01T00:00:00.000Z',
    txId: 'test12345678901234567890123456789012345678901',
    level: 3,
    existence: {
      status: 'confirmed',
      blockHeight: 888672,
      blockTimestamp: '2022-03-09T04:26:40.000Z',
      blockId: 'block-id-123',
      confirmations: 100000,
    },
    authenticity: {
      status: 'signature_verified',
      signatureValid: true,
      signatureSkipReason: null,
      dataHash: 'testhash123456789012345678901234567890abc',
      gatewayHash: 'testhash123456789012345678901234567890abc',
      hashMatch: true,
    },
    owner: {
      address: 'testowner12345678901234567890123456789012',
      publicKey: null,
      addressVerified: true,
    },
    metadata: {
      dataSize: 920122,
      contentType: 'application/pdf',
      tags: [
        { name: 'App-Name', value: 'ArDrive' },
        { name: 'Content-Type', value: 'application/pdf' },
      ],
    },
    bundle: { isBundled: false, rootTransactionId: null },
    gatewayAssessment: { verified: null, stable: null, trusted: true, hops: 1 },
    links: { dashboard: '/report/vrf_test', pdf: '/api/v1/verify/vrf_test/pdf', rawData: 'https://arweave.net/test' },
    ...overrides,
  };
}

describe('PDF Generator', () => {
  it('generates valid PDF bytes for Level 3 result', async () => {
    const pdf = await generatePdf(makeResult());
    expect(pdf.byteLength).toBeGreaterThan(100);
    // PDF starts with %PDF
    const header = Buffer.from(pdf.slice(0, 5)).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('generates PDF for Level 1 result', async () => {
    const pdf = await generatePdf(
      makeResult({
        level: 1,
        existence: { status: 'pending', blockHeight: null, blockTimestamp: null, blockId: null, confirmations: null },
        authenticity: { status: 'unverified', signatureValid: null, signatureSkipReason: 'Not indexed', dataHash: null, gatewayHash: null, hashMatch: null },
      })
    );
    expect(pdf.byteLength).toBeGreaterThan(100);
  });

  it('generates PDF for bundled data item', async () => {
    const pdf = await generatePdf(
      makeResult({
        bundle: { isBundled: true, rootTransactionId: 'root12345678901234567890123456789012345678' },
      })
    );
    expect(pdf.byteLength).toBeGreaterThan(100);
  });
});
