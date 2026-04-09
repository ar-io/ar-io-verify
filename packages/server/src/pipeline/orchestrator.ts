import { nanoid } from 'nanoid';
import { logger } from '../utils/logger.js';
import { createAttestation } from '../utils/signing.js';
import {
  verifyDataItemSignature,
  verifyDataItemSignatureRaw,
  verifyTransactionSignature,
  bufferToBase64Url,
  ownerToAddress,
  sha256B64Url,
} from '../utils/crypto.js';
import {
  headRawData,
  getRawData,
  getDataItemHeader,
  getTransaction,
  getTransactionViaGraphQL,
} from '../gateway/client.js';
import { parseDataItemHeader } from '../utils/ans104-parser.js';
import type { VerificationResult, VerifyRequest } from '../types.js';
import type { RawDataHeaders } from '../gateway/types.js';

/**
 * Optimized verification pipeline:
 * 1. HEAD /raw/ + GraphQL — in parallel (~50ms)
 * 2. Determine L1 vs data item from results
 * 3. If L1: GET /tx/ for format, data_root, quantity, reward
 * 4. Download raw data + fetch binary header (if offsets available)
 * 5. Signature verification
 */
export async function runVerification(request: VerifyRequest): Promise<VerificationResult> {
  const verificationId = `vrf_${nanoid(16)}`;
  const timestamp = new Date().toISOString();
  const { txId } = request;

  logger.info({ verificationId, txId }, 'Starting verification');

  // Step 1: HEAD /raw/ and GraphQL in parallel
  const [headers, gql] = await Promise.all([headRawData(txId), getTransactionViaGraphQL(txId)]);

  // If neither returned data, tx doesn't exist
  if (!headers && !gql) {
    return buildNotFoundResult(verificationId, timestamp, txId);
  }

  // Existence from GraphQL block info
  const existence: VerificationResult['existence'] = gql?.blockHeight
    ? {
        status: 'confirmed',
        blockHeight: gql.blockHeight,
        blockTimestamp: gql.blockTimestamp,
        blockId: null,
        confirmations: null,
      }
    : {
        status: headers ? 'pending' : 'not_found',
        blockHeight: null,
        blockTimestamp: null,
        blockId: null,
        confirmations: null,
      };

  // Owner from GraphQL or headers
  const ownerPubKey = gql?.ownerKey ?? headers?.owner ?? null;
  const ownerAddress =
    gql?.ownerAddress ??
    headers?.ownerAddress ??
    (ownerPubKey && ownerPubKey.length > 100 ? ownerToAddress(ownerPubKey) : ownerPubKey);
  const addressVerified = ownerPubKey && ownerPubKey.length > 100 && ownerAddress
    ? ownerToAddress(ownerPubKey) === ownerAddress
    : null;

  // Tags from GraphQL (correct order) or headers (alphabetical, fallback)
  const displayTags = gql?.tags?.length ? gql.tags : headers?.tags ?? [];

  // Determine if this is a bundled data item or L1 tx
  const isBundled = !!headers?.rootTransactionId && headers.rootTransactionId !== txId;

  // Content info
  const contentType = headers?.contentType ?? displayTags.find((t) => t.name === 'Content-Type')?.value ?? null;
  const dataSize = headers?.contentLength ?? null;

  // Gateway assessment
  const gatewayAssessment: VerificationResult['gatewayAssessment'] = {
    verified: headers?.arIoVerified ?? null,
    stable: headers?.arIoStable ?? null,
    trusted: headers?.arIoTrusted ?? null,
    hops: headers?.arIoHops ?? null,
  };

  // Step 2: Download raw data (required) + attempt binary header (optional, best-effort)
  const dataDownload = headers ? getRawData(txId, headers.contentLength) : Promise.resolve(null);

  // Binary header: essential for non-RSA sig types, nice-to-have for RSA.
  // For non-RSA (ECDSA/ED25519), the exact tag bytes are required for deep hash.
  // Use a longer timeout for non-RSA since without it, verification will be skipped.
  let binaryHeaderBuf: Buffer | null = null;
  if (headers?.rootTransactionId && headers.dataItemOffset !== null && headers.dataItemDataOffset !== null) {
    const isNonRsa = headers.signatureType !== null && headers.signatureType !== 1;
    const timeoutMs = isNonRsa ? 10000 : 3000;
    const headerFetch = getDataItemHeader(headers.rootTransactionId, headers.dataItemOffset, headers.dataItemDataOffset);
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    binaryHeaderBuf = await Promise.race([headerFetch, timeoutPromise]);
  }

  const rawData = await dataDownload;

  // Parse binary header if available
  const parsedHeader = binaryHeaderBuf ? parseDataItemHeader(binaryHeaderBuf) : null;
  if (parsedHeader) {
    logger.info({ txId, sigType: parsedHeader.signatureType, tagCount: parsedHeader.tagCount }, 'Parsed ANS-104 binary header');
  }

  // Compute independent hash
  const independentHash = rawData ? sha256B64Url(rawData) : null;
  const gatewayHash = headers?.digest ?? null;
  const hashMatch = independentHash ? (gatewayHash ? gatewayHash === independentHash : true) : null;

  // Step 3: For L1 transactions, fetch /tx/ for deep hash fields
  let l1TxData: {
    format: number;
    quantity: string;
    reward: string;
    dataRoot: string;
    dataSize: string;
    target: string;
    anchor: string;
    rawTags: Array<{ name: string; value: string }>;
    signature: string;
  } | null = null;

  if (!isBundled && headers) {
    // Might be L1 — check via /tx/ (Envoy routes to Arweave peers, works for L1)
    const tx = await getTransaction(txId);
    if (tx && (tx.reward !== '0' || tx.data_root !== '')) {
      l1TxData = {
        format: tx.format,
        quantity: tx.quantity,
        reward: tx.reward,
        dataRoot: tx.data_root,
        dataSize: tx.data_size,
        target: tx.target,
        anchor: tx.last_tx,
        rawTags: tx.tags,
        signature: tx.signature,
      };
    }
  }

  // Step 4: Signature verification
  const signatureB64 = headers?.signature ?? l1TxData?.signature ?? null;

  const sigResult = await attemptSignatureVerification({
    parsedHeader,
    signatureB64Url: signatureB64,
    ownerB64Url: ownerPubKey,
    rawDataBytes: rawData,
    rawContentLength: dataSize,
    // Data item fields (from GraphQL or headers)
    tagsB64: gql?.tags
      ? gql.tags.map((t) => ({
          name: bufferToBase64Url(Buffer.from(t.name, 'utf-8')),
          value: bufferToBase64Url(Buffer.from(t.value, 'utf-8')),
        }))
      : [],
    anchorB64Url: headers?.anchor ?? '',
    targetB64Url: '',
    signatureType: headers?.signatureType ?? null,
    // L1 fields
    l1TxData,
    txId,
    verificationId,
  });

  // Compute level
  const signaturePassed = sigResult.signatureValid === true;
  const hashAvailable = !!independentHash;
  const level: 1 | 2 | 3 = signaturePassed ? 3 : hashAvailable ? 2 : 1;
  const authenticityStatus: VerificationResult['authenticity']['status'] = signaturePassed
    ? 'signature_verified'
    : hashAvailable
      ? 'hash_verified'
      : 'unverified';

  const result: VerificationResult = {
    verificationId,
    timestamp,
    txId,
    level,
    existence,
    authenticity: {
      status: authenticityStatus,
      signatureValid: sigResult.signatureValid,
      signatureSkipReason: sigResult.signatureSkipReason,
      dataHash: independentHash,
      gatewayHash,
      hashMatch,
    },
    owner: {
      address: ownerAddress,
      publicKey: ownerPubKey,
      addressVerified,
    },
    metadata: { dataSize, contentType, tags: displayTags },
    bundle: {
      isBundled,
      rootTransactionId: isBundled ? headers?.rootTransactionId ?? null : null,
    },
    gatewayAssessment,
    attestation: null,
    links: {
      dashboard: `/report/${verificationId}`,
      pdf: `/api/v1/verify/${verificationId}/pdf`,
      rawData: `https://arweave.net/${txId}`,
    },
  };

  // Sign the attestation with the operator's wallet (if configured)
  result.attestation = createAttestation(result);

  logger.info(
    { verificationId, txId, level, authenticity: authenticityStatus, existence: existence.status, attested: !!result.attestation },
    'Verification complete'
  );

  return result;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

interface SigVerifyInput {
  parsedHeader: import('../utils/ans104-parser.js').ParsedDataItemHeader | null;
  signatureB64Url: string | null;
  ownerB64Url: string | null;
  rawDataBytes: Buffer | null;
  rawContentLength: number | null;
  tagsB64: Array<{ name: string; value: string }>;
  anchorB64Url: string;
  targetB64Url: string;
  signatureType: number | null;
  l1TxData: {
    format: number;
    quantity: string;
    reward: string;
    dataRoot: string;
    dataSize: string;
    target: string;
    anchor: string;
    rawTags: Array<{ name: string; value: string }>;
    signature: string;
  } | null;
  txId: string;
  verificationId: string;
}

async function attemptSignatureVerification(input: SigVerifyInput): Promise<{
  signatureValid: boolean | null;
  signatureSkipReason: string | null;
}> {
  const {
    parsedHeader,
    signatureB64Url,
    ownerB64Url,
    rawDataBytes,
    rawContentLength,
    tagsB64,
    anchorB64Url,
    targetB64Url,
    signatureType,
    l1TxData,
    txId,
    verificationId,
  } = input;

  if (!signatureB64Url && !parsedHeader && !l1TxData?.signature) {
    return { signatureValid: null, signatureSkipReason: 'No signature available' };
  }
  if (!ownerB64Url && !parsedHeader) {
    return { signatureValid: null, signatureSkipReason: 'No owner public key available' };
  }
  // 43 chars = wallet address only (no public key). Longer values are valid keys for non-RSA sig types.
  if (ownerB64Url && ownerB64Url.length <= 43 && !parsedHeader) {
    return { signatureValid: null, signatureSkipReason: 'Only wallet address available, full public key required' };
  }

  const sizeSkipMsg =
    rawContentLength && rawContentLength > 100 * 1024 * 1024
      ? `File too large for verification (${(rawContentLength / 1024 / 1024).toFixed(0)} MB). Maximum supported size is 100 MB.`
      : null;

  try {
    let valid: boolean;

    if (l1TxData) {
      // L1 transaction
      const sig = l1TxData.signature || signatureB64Url;
      if (!sig) return { signatureValid: null, signatureSkipReason: 'No signature' };
      if (l1TxData.format === 1 && !rawDataBytes) {
        return { signatureValid: null, signatureSkipReason: sizeSkipMsg ?? 'Raw data unavailable for format 1' };
      }
      valid = verifyTransactionSignature({
        format: l1TxData.format,
        signatureB64Url: sig,
        ownerB64Url: ownerB64Url!,
        targetB64Url: l1TxData.target,
        anchorB64Url: l1TxData.anchor,
        rawTags: l1TxData.rawTags,
        quantity: l1TxData.quantity,
        reward: l1TxData.reward,
        dataRoot: l1TxData.dataRoot,
        dataSize: l1TxData.dataSize,
        data: rawDataBytes,
      });
    } else {
      // Data item
      if (!rawDataBytes) {
        return { signatureValid: null, signatureSkipReason: sizeSkipMsg ?? 'Raw data unavailable' };
      }

      // Prefer binary header (exact bytes, 100% accurate)
      if (parsedHeader) {
        valid = await verifyDataItemSignatureRaw({
          signatureType: parsedHeader.signatureType,
          signature: parsedHeader.signature,
          owner: parsedHeader.owner,
          target: parsedHeader.target,
          anchor: parsedHeader.anchor,
          rawTagBytes: parsedHeader.rawTagBytes,
          data: rawDataBytes,
        });
      } else if ((signatureType ?? 1) !== 1 && !parsedHeader) {
        // Non-RSA types (ED25519, ECDSA) require exact binary tags for deep hash.
        // Re-encoded GraphQL tags may differ from original bytes, causing recovery mismatch.
        return {
          signatureValid: null,
          signatureSkipReason: 'Binary header unavailable. Non-RSA signatures require exact tag bytes from the bundle.',
        };
      } else if (tagsB64.length > 0 && signatureB64Url && ownerB64Url) {
        // RSA fallback: GraphQL tags (correct order, re-encoded) — RSA-PSS is tolerant
        valid = verifyDataItemSignature({
          signatureType: signatureType ?? 1,
          signatureB64Url,
          ownerB64Url,
          targetB64Url,
          anchorB64Url,
          rawTags: tagsB64,
          data: rawDataBytes,
        });
      } else {
        return { signatureValid: null, signatureSkipReason: 'Insufficient data for signature verification' };
      }
    }

    logger.info({ verificationId, txId, signatureValid: valid }, 'Signature verification completed');
    return { signatureValid: valid, signatureSkipReason: null };
  } catch (error) {
    logger.error({ error, verificationId, txId }, 'Signature verification error');
    return {
      signatureValid: null,
      signatureSkipReason: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Not-found result
// ---------------------------------------------------------------------------

function buildNotFoundResult(verificationId: string, timestamp: string, txId: string): VerificationResult {
  return {
    verificationId,
    timestamp,
    txId,
    level: 1,
    existence: { status: 'not_found', blockHeight: null, blockTimestamp: null, blockId: null, confirmations: null },
    authenticity: { status: 'unverified', signatureValid: null, signatureSkipReason: 'Transaction not found', dataHash: null, gatewayHash: null, hashMatch: null },
    owner: { address: null, publicKey: null, addressVerified: null },
    metadata: { dataSize: null, contentType: null, tags: [] },
    bundle: { isBundled: false, rootTransactionId: null },
    gatewayAssessment: { verified: null, stable: null, trusted: null, hops: null },
    attestation: null,
    links: { dashboard: null, pdf: null, rawData: null },
  };
}
