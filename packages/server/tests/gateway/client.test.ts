import { describe, it, expect, afterAll, vi } from 'vitest';

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

import txResponse from '../fixtures/tx-response.json';
import txStatus from '../fixtures/tx-status.json';
import blockResponse from '../fixtures/block-response.json';

describe('Gateway Client', () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('getTransaction returns parsed transaction', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(txResponse), { status: 200 })) as typeof fetch;

    const { getTransaction } = await import('../../src/gateway/client.js');
    const tx = await getTransaction('4jBV3ofWh41KhuTs2pFvj-KBZWUkbrbCYlJH0vLA6LM');
    expect(tx).not.toBeNull();
    expect(tx!.id).toBe('4jBV3ofWh41KhuTs2pFvj-KBZWUkbrbCYlJH0vLA6LM');
  });

  it('getTransaction returns null on 404', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;

    const { getTransaction } = await import('../../src/gateway/client.js');
    const tx = await getTransaction('nonexistent');
    expect(tx).toBeNull();
  });

  it('getTransactionStatus returns parsed status', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(txStatus), { status: 200 })) as typeof fetch;

    const { getTransactionStatus } = await import('../../src/gateway/client.js');
    const status = await getTransactionStatus('test-tx');
    expect(status).not.toBeNull();
    expect(status!.block_height).toBe(1438221);
  });

  it('getBlock returns parsed block', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(blockResponse), { status: 200 })) as typeof fetch;

    const { getBlock } = await import('../../src/gateway/client.js');
    const block = await getBlock(1438221);
    expect(block).not.toBeNull();
    expect(block!.height).toBe(1438221);
  });

  it('headRawData returns all header fields', async () => {
    globalThis.fetch = (async () =>
      new Response('', {
        status: 200,
        headers: {
          'x-ar-io-digest': 'sha256hash',
          'x-ar-io-root-transaction-id': 'root-tx-123',
          'content-type': 'application/pdf',
          'content-length': '245678',
          'x-arweave-signature': 'sig-base64url',
          'x-arweave-owner': 'owner-base64url',
          'x-arweave-owner-address': 'addr-base64url',
          'x-arweave-signature-type': '1',
          'x-ar-io-verified': 'true',
          'x-ar-io-stable': 'false',
          'x-ar-io-trusted': 'true',
          'x-ar-io-hops': '2',
          'x-ar-io-data-id': 'data-id-123',
          'x-ar-io-data-item-offset': '3124',
          'x-ar-io-data-item-data-offset': '4271',
          'x-arweave-tag-count': '3',
          'x-arweave-tag-app-name': 'ArDrive',
          'x-arweave-tag-content-type': 'application/pdf',
        },
      })) as typeof fetch;

    const { headRawData } = await import('../../src/gateway/client.js');
    const h = await headRawData('test-tx');
    expect(h).not.toBeNull();
    expect(h!.digest).toBe('sha256hash');
    expect(h!.signature).toBe('sig-base64url');
    expect(h!.owner).toBe('owner-base64url');
    expect(h!.ownerAddress).toBe('addr-base64url');
    expect(h!.signatureType).toBe(1);
    expect(h!.arIoVerified).toBe(true);
    expect(h!.arIoStable).toBe(false);
    expect(h!.arIoTrusted).toBe(true);
    expect(h!.arIoHops).toBe(2);
    expect(h!.dataItemOffset).toBe(3124);
    expect(h!.dataItemDataOffset).toBe(4271);
    expect(h!.tags.length).toBe(2);
    expect(h!.tagCount).toBe(3);
  });

  it('getTransactionViaGraphQL returns tags and block info', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            transaction: {
              tags: [
                { name: 'App-Name', value: 'ArDrive' },
                { name: 'Content-Type', value: 'image/png' },
              ],
              owner: { address: 'addr123', key: 'pubkey123' },
              block: { height: 888672, timestamp: 1646800000 },
            },
          },
        }),
        { status: 200 }
      )) as typeof fetch;

    const { getTransactionViaGraphQL } = await import('../../src/gateway/client.js');
    const result = await getTransactionViaGraphQL('test-tx');
    expect(result).not.toBeNull();
    expect(result!.tags.length).toBe(2);
    expect(result!.tags[0].name).toBe('App-Name');
    expect(result!.ownerKey).toBe('pubkey123');
    expect(result!.ownerAddress).toBe('addr123');
    expect(result!.blockHeight).toBe(888672);
    expect(result!.blockTimestamp).toContain('2022');
  });

  it('getTransactionViaGraphQL returns null when not found', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { transaction: null } }), { status: 200 })) as typeof fetch;

    const { getTransactionViaGraphQL } = await import('../../src/gateway/client.js');
    const result = await getTransactionViaGraphQL('nonexistent');
    expect(result).toBeNull();
  });

  it('getRawData downloads data within size limit', async () => {
    const testData = Buffer.from('hello world');
    globalThis.fetch = (async () =>
      new Response(testData, {
        status: 200,
        headers: { 'content-length': String(testData.length) },
      })) as typeof fetch;

    const { getRawData } = await import('../../src/gateway/client.js');
    const data = await getRawData('test-tx', testData.length);
    expect(data).not.toBeNull();
    expect(data!.toString()).toBe('hello world');
  });

  it('getRawData skips data exceeding size limit', async () => {
    const { getRawData } = await import('../../src/gateway/client.js');
    // 200MB exceeds 100MB limit
    const data = await getRawData('test-tx', 200 * 1024 * 1024);
    expect(data).toBeNull();
  });

  it('checkGatewayHealth returns true on 200', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as typeof fetch;

    const { checkGatewayHealth } = await import('../../src/gateway/client.js');
    expect(await checkGatewayHealth()).toBe(true);
  });

  it('checkGatewayHealth returns false on error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;

    const { checkGatewayHealth } = await import('../../src/gateway/client.js');
    expect(await checkGatewayHealth()).toBe(false);
  });
});
