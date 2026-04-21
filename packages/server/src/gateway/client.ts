import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fetchWithTimeout } from '../utils/http.js';
import type { GatewayTransaction, RawDataHeaders } from './types.js';

const baseUrl = config.GATEWAY_URL.replace(/\/$/, '');
const timeout = config.GATEWAY_TIMEOUT_MS;

/** Max bytes to download for verification (100 MB) */
const MAX_RAW_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export async function getTransaction(txId: string): Promise<GatewayTransaction | null> {
  // No retries — /tx/ routes through Envoy to L1 peers, which return 404 immediately
  // for bundled data items. The pipeline falls back to /raw/ headers + GraphQL.
  try {
    const res = await fetchWithTimeout(`${baseUrl}/tx/${txId}`, timeout);
    if (res.status === 404) return null;
    if (!res.ok) {
      logger.warn({ status: res.status, txId }, 'Unexpected response from GET /tx');
      return null;
    }
    return (await res.json()) as GatewayTransaction;
  } catch (error) {
    logger.error({ error, txId }, 'Failed to fetch transaction');
    return null;
  }
}

function parseBoolHeader(value: string | null): boolean | null {
  if (value === null) return null;
  return value === 'true';
}

function parseIntHeader(value: string | null): number | null {
  if (value === null) return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

const EMPTY_HEADERS: RawDataHeaders = {
  digest: null,
  rootTransactionId: null,
  contentType: null,
  contentLength: null,
  signature: null,
  owner: null,
  ownerAddress: null,
  signatureType: null,
  anchor: null,
  tags: [],
  tagCount: null,
  dataItemOffset: null,
  dataItemDataOffset: null,
  arIoVerified: null,
  arIoStable: null,
  arIoTrusted: null,
  arIoHops: null,
  arIoDataId: null,
};

/**
 * Parse x-arweave-tag-* headers into tag name/value pairs.
 * Header format: x-arweave-tag-{lowercased-hyphenated-name}: {value}
 * We reconstruct the original tag name by converting hyphens back to hyphens
 * and title-casing each word (matching Arweave convention).
 */
function parseTagHeaders(headers: Headers): Array<{ name: string; value: string }> {
  const tags: Array<{ name: string; value: string }> = [];
  const prefix = 'x-arweave-tag-';

  headers.forEach((value, key) => {
    if (key.startsWith(prefix) && key !== 'x-arweave-tag-count') {
      // Convert header key to tag name: x-arweave-tag-content-type → Content-Type
      const rawName = key.slice(prefix.length);
      const tagName = rawName
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('-');
      tags.push({ name: tagName, value });
    }
  });

  return tags;
}

export async function headRawData(txId: string): Promise<RawDataHeaders | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/raw/${txId}`, timeout, { method: 'HEAD' });
    if (res.status === 404) {
      return { ...EMPTY_HEADERS };
    }
    if (!res.ok) {
      logger.warn({ status: res.status, txId }, 'Unexpected response from HEAD /raw');
      return null;
    }

    const h = res.headers;
    return {
      digest: h.get('x-ar-io-digest'),
      rootTransactionId: h.get('x-ar-io-root-transaction-id'),
      contentType: h.get('content-type'),
      contentLength: parseIntHeader(h.get('content-length')),

      signature: h.get('x-arweave-signature'),
      owner: h.get('x-arweave-owner'),
      ownerAddress: h.get('x-arweave-owner-address'),
      signatureType: parseIntHeader(h.get('x-arweave-signature-type')),
      anchor: h.get('x-arweave-anchor'),

      tags: parseTagHeaders(h),
      tagCount: parseIntHeader(h.get('x-arweave-tag-count')),
      dataItemOffset: parseIntHeader(h.get('x-ar-io-data-item-offset')),
      dataItemDataOffset: parseIntHeader(h.get('x-ar-io-data-item-data-offset')),

      arIoVerified: parseBoolHeader(h.get('x-ar-io-verified')),
      arIoStable: parseBoolHeader(h.get('x-ar-io-stable')),
      arIoTrusted: parseBoolHeader(h.get('x-ar-io-trusted')),
      arIoHops: parseIntHeader(h.get('x-ar-io-hops')),
      arIoDataId: h.get('x-ar-io-data-id'),
    };
  } catch (error) {
    logger.error({ error, txId }, 'Failed to HEAD raw data');
    return null;
  }
}

/**
 * Fetch the ANS-104 data item header bytes via range request on the root bundle.
 * The header contains: signature_type, signature, owner, target, anchor, and
 * the exact Avro-serialized tag bytes in original order.
 */
export async function getDataItemHeader(
  rootTxId: string,
  dataItemOffset: number,
  dataOffset: number
): Promise<Buffer | null> {
  const headerSize = dataOffset - dataItemOffset;
  if (headerSize <= 0 || headerSize > 100_000) {
    logger.warn({ rootTxId, headerSize }, 'Invalid data item header size');
    return null;
  }

  try {
    const rangeEnd = dataOffset - 1;
    const res = await fetchWithTimeout(`${baseUrl}/raw/${rootTxId}`, timeout, {
      headers: { Range: `bytes=${dataItemOffset}-${rangeEnd}` },
    });

    if (res.status === 206 || res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      // Range response may return the full body if range not supported
      if (buf.length >= headerSize) {
        return buf.slice(0, headerSize);
      }
      return buf;
    }

    logger.warn({ status: res.status, rootTxId }, 'Range request failed');
    return null;
  } catch (error) {
    logger.error({ error, rootTxId }, 'Failed to fetch data item header');
    return null;
  }
}

/**
 * Download raw transaction data for independent hash verification.
 * Returns null if the data exceeds MAX_RAW_DOWNLOAD_BYTES or is unavailable.
 */
export async function getRawData(
  txId: string,
  expectedSize: number | null
): Promise<Buffer | null> {
  if (expectedSize !== null && expectedSize > MAX_RAW_DOWNLOAD_BYTES) {
    logger.info(
      { txId, size: expectedSize, limit: MAX_RAW_DOWNLOAD_BYTES },
      'Skipping raw download: exceeds size limit'
    );
    return null;
  }

  try {
    const res = await fetchWithTimeout(`${baseUrl}/raw/${txId}`, timeout);
    if (!res.ok) return null;

    const lengthStr = res.headers.get('content-length');
    if (lengthStr && parseInt(lengthStr, 10) > MAX_RAW_DOWNLOAD_BYTES) {
      logger.info({ txId, size: lengthStr }, 'Skipping raw download: content-length exceeds limit');
      return null;
    }

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > MAX_RAW_DOWNLOAD_BYTES) {
      return null;
    }
    return Buffer.from(arrayBuf);
  } catch (error) {
    logger.error({ error, txId }, 'Failed to download raw data');
    return null;
  }
}

/**
 * Query GraphQL for transaction data including tags, owner, and block info.
 * This is the reliable source for data items that /tx/ can't serve.
 */
export async function getTransactionViaGraphQL(txId: string): Promise<{
  tags: Array<{ name: string; value: string }>;
  ownerKey: string | null;
  ownerAddress: string | null;
  blockHeight: number | null;
  blockTimestamp: string | null;
  blockId: string | null;
} | null> {
  try {
    const query = `{ transaction(id: "${txId}") { tags { name value } owner { address key } block { height timestamp id } } }`;
    const res = await fetchWithTimeout(`${baseUrl}/graphql`, timeout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, txId }, 'GraphQL request failed');
      return null;
    }
    const data = await res.json();
    if (data?.errors) {
      logger.warn({ errors: data.errors, txId }, 'GraphQL returned errors');
      return null;
    }
    const tx = data?.data?.transaction;
    if (!tx) return null;
    return {
      tags: tx.tags ?? [],
      ownerKey: tx.owner?.key ?? null,
      ownerAddress: tx.owner?.address ?? null,
      blockHeight: tx.block?.height ?? null,
      blockTimestamp: tx.block?.timestamp
        ? new Date(tx.block.timestamp * 1000).toISOString()
        : null,
      blockId: tx.block?.id ?? null,
    };
  } catch (error) {
    logger.warn({ error, txId }, 'GraphQL query threw');
    return null;
  }
}

export async function checkGatewayHealth(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/ar-io/info`, 5000);
    return res.ok;
  } catch {
    return false;
  }
}
