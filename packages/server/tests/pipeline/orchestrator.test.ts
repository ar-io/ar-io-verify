import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    PORT: 4001,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    GATEWAY_URL: 'http://localhost:9999',
    GATEWAY_TIMEOUT_MS: 5000,
    SQLITE_PATH: ':memory:',
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Mock the gateway client — control what each function returns
const mockHeadRawData = vi.fn();
const mockGetRawData = vi.fn();
const mockGetDataItemHeader = vi.fn();
const mockGetTransaction = vi.fn();
const mockGetTransactionViaGraphQL = vi.fn();

vi.mock('../../src/gateway/client.js', () => ({
  headRawData: (...args: unknown[]) => mockHeadRawData(...args),
  getRawData: (...args: unknown[]) => mockGetRawData(...args),
  getDataItemHeader: (...args: unknown[]) => mockGetDataItemHeader(...args),
  getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
  getTransactionViaGraphQL: (...args: unknown[]) => mockGetTransactionViaGraphQL(...args),
}));

// Mock the ANS-104 parser
vi.mock('../../src/utils/ans104-parser.js', () => ({
  parseDataItemHeader: () => null,
}));

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDataItemHeader.mockResolvedValue(null);
    mockGetTransaction.mockResolvedValue(null);
  });

  it('returns not_found when both HEAD and GraphQL return nothing', async () => {
    mockHeadRawData.mockResolvedValue(null);
    mockGetTransactionViaGraphQL.mockResolvedValue(null);

    const { runVerification } = await import('../../src/pipeline/orchestrator.js');
    const result = await runVerification({ txId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

    expect(result.level).toBe(1);
    expect(result.existence.status).toBe('not_found');
    expect(result.authenticity.status).toBe('unverified');
  });

  it('returns Level 2 (hash verified) when HEAD + raw data available but no sig', async () => {
    mockHeadRawData.mockResolvedValue({
      digest: 'testdigest123',
      rootTransactionId: null,
      contentType: 'image/png',
      contentLength: 100,
      signature: null,
      owner: null,
      ownerAddress: null,
      signatureType: null,
      anchor: null,
      tags: [{ name: 'Content-Type', value: 'image/png' }],
      tagCount: 1,
      dataItemOffset: null,
      dataItemDataOffset: null,
      arIoVerified: null,
      arIoStable: null,
      arIoTrusted: true,
      arIoHops: 1,
      arIoDataId: 'test-id',
    });
    mockGetTransactionViaGraphQL.mockResolvedValue(null);
    mockGetRawData.mockResolvedValue(Buffer.from('test data'));

    const { runVerification } = await import('../../src/pipeline/orchestrator.js');
    const result = await runVerification({ txId: 'test12345678901234567890123456789012345678901' });

    expect(result.level).toBe(2);
    expect(result.authenticity.status).toBe('hash_verified');
    expect(result.authenticity.dataHash).not.toBeNull();
  });

  it('uses GraphQL block info for existence', async () => {
    mockHeadRawData.mockResolvedValue({
      digest: 'hash123',
      rootTransactionId: 'root123',
      contentType: 'application/pdf',
      contentLength: 1000,
      signature: null,
      owner: null,
      ownerAddress: null,
      signatureType: null,
      anchor: null,
      tags: [],
      tagCount: 0,
      dataItemOffset: null,
      dataItemDataOffset: null,
      arIoVerified: null,
      arIoStable: null,
      arIoTrusted: null,
      arIoHops: null,
      arIoDataId: null,
    });
    mockGetTransactionViaGraphQL.mockResolvedValue({
      tags: [{ name: 'Content-Type', value: 'application/pdf' }],
      ownerKey: null,
      ownerAddress: 'addr123',
      blockHeight: 888672,
      blockTimestamp: '2022-03-09T04:26:40.000Z',
    });
    mockGetRawData.mockResolvedValue(Buffer.from('pdf bytes'));

    const { runVerification } = await import('../../src/pipeline/orchestrator.js');
    const result = await runVerification({ txId: 'test12345678901234567890123456789012345678901' });

    expect(result.existence.status).toBe('confirmed');
    expect(result.existence.blockHeight).toBe(888672);
    expect(result.existence.blockTimestamp).toContain('2022');
  });

  it('detects bundle from root transaction ID', async () => {
    mockHeadRawData.mockResolvedValue({
      digest: null,
      rootTransactionId: 'different-root-tx-id-padded-to-43-chars--',
      contentType: 'video/mp4',
      contentLength: 5000,
      signature: null,
      owner: null,
      ownerAddress: null,
      signatureType: null,
      anchor: null,
      tags: [],
      tagCount: 0,
      dataItemOffset: null,
      dataItemDataOffset: null,
      arIoVerified: null,
      arIoStable: null,
      arIoTrusted: null,
      arIoHops: null,
      arIoDataId: null,
    });
    mockGetTransactionViaGraphQL.mockResolvedValue(null);
    mockGetRawData.mockResolvedValue(null);

    const { runVerification } = await import('../../src/pipeline/orchestrator.js');
    const result = await runVerification({ txId: 'test12345678901234567890123456789012345678901' });

    expect(result.bundle.isBundled).toBe(true);
    expect(result.bundle.rootTransactionId).toBe('different-root-tx-id-padded-to-43-chars--');
  });

  it('populates metadata from GraphQL tags', async () => {
    mockHeadRawData.mockResolvedValue({
      digest: null,
      rootTransactionId: null,
      contentType: 'image/jpeg',
      contentLength: 500,
      signature: null,
      owner: null,
      ownerAddress: null,
      signatureType: null,
      anchor: null,
      tags: [],
      tagCount: 0,
      dataItemOffset: null,
      dataItemDataOffset: null,
      arIoVerified: null,
      arIoStable: null,
      arIoTrusted: null,
      arIoHops: null,
      arIoDataId: null,
    });
    mockGetTransactionViaGraphQL.mockResolvedValue({
      tags: [
        { name: 'App-Name', value: 'ArDrive' },
        { name: 'Content-Type', value: 'image/jpeg' },
      ],
      ownerKey: null,
      ownerAddress: 'owner-addr',
      blockHeight: 100,
      blockTimestamp: '2023-01-01T00:00:00.000Z',
    });
    mockGetRawData.mockResolvedValue(null);

    const { runVerification } = await import('../../src/pipeline/orchestrator.js');
    const result = await runVerification({ txId: 'test12345678901234567890123456789012345678901' });

    expect(result.metadata.tags.length).toBe(2);
    expect(result.metadata.tags[0].name).toBe('App-Name');
    expect(result.metadata.contentType).toBe('image/jpeg');
  });

  it('generates valid verification ID and links', async () => {
    mockHeadRawData.mockResolvedValue(null);
    mockGetTransactionViaGraphQL.mockResolvedValue({
      tags: [],
      ownerKey: null,
      ownerAddress: null,
      blockHeight: null,
      blockTimestamp: null,
    });

    const { runVerification } = await import('../../src/pipeline/orchestrator.js');
    const result = await runVerification({ txId: 'test12345678901234567890123456789012345678901' });

    expect(result.verificationId).toMatch(/^vrf_/);
    expect(result.verificationId.length).toBeGreaterThan(10);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}/);
  });
});
