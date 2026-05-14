import { config } from '../config.js';
import {
  getOperatorAddress,
  getOperatorPublicKey,
  isSigningEnabled,
  signPayload,
} from '../utils/signing.js';
import { canonicalize } from '../utils/canonical.js';
import { sha256B64Url } from '../utils/crypto.js';
import { merkleRootFromCanonicalEntries } from '../utils/merkle.js';
import { logger } from '../utils/logger.js';
import { SERVER_VERSION } from '../version.js';
import {
  REFERENCE_VERIFIER_URL,
  BUNDLE_CONFORMANCE,
  SIGNATURE_ALGORITHM,
  CANONICALIZATION_SPEC,
  KNOWN_LIMITATIONS,
} from '../attestation/compliance.js';
import * as jobs from '../storage/jobs.js';
import type { VerificationResult } from '../types.js';

export const BUNDLE_VERSION = 2;
export const BUNDLE_TYPE = 'VerificationBundle';
export const BUNDLE_SCHEMA_URL = 'https://verify.ar.io/schemas/v2/bundle.json';
export const BUNDLE_CONTEXT_URL = 'https://verify.ar.io/contexts/v2';

export { REFERENCE_VERIFIER_URL, SIGNATURE_ALGORITHM };

/**
 * Cap on rows enumerated inside the bundle. Both verified and failed entries
 * are capped independently — beyond this, callers walk
 * GET /api/v1/jobs/:id/results for the full list. The Merkle root is still
 * computed over what's enumerated, so it represents only the embedded view.
 */
const ENTRY_CAP = 1000;

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface BundleVerifiedEntry {
  txId: string;
  level: 1 | 2 | 3;
  /**
   * Per-tx cryptographic bindings to the data. At least one of these is
   * always non-null for a verified row (otherwise the row wouldn't have
   * been classified as `verified`):
   *
   *   - `dataSha256` — SHA-256 of the bytes we independently downloaded.
   *     Null when raw data wasn't fetched (large/missing), in which case
   *     verification was anchored via `dataRoot` (L1 format-2) or via
   *     the L2 data item's own signature.
   *   - `dataRoot`   — Arweave L1 format-2 chunk Merkle root. The on-chain
   *     binding the signer attested. Recoverable from any Arweave peer
   *     via `recovery.arweave`.
   *   - `signatureType` — Named algorithm string that verified this row.
   *     Lets the auditor pick the right primitive when independently
   *     re-verifying.
   */
  dataSha256: string | null;
  dataRoot: string | null;
  signatureType: VerificationResult['authenticity']['signatureType'];
  owner: string | null;
  blockHeight: number | null;
  blockTimestamp: string | null;
  isBundled: boolean;
  bundleRootTxId: string | null;
  recovery: VerificationResult['recovery'];
  verificationId: string | null;
}

export interface BundleFailedEntry {
  txId: string;
  outcome: 'unavailable' | 'tampered';
  failureReason: string | null;
  verificationId: string | null;
}

export interface VerificationBundleV2 {
  $schema: string;
  '@context': string;
  type: typeof BUNDLE_TYPE;
  version: typeof BUNDLE_VERSION;

  id: string;
  jobId: string;
  runId: string;
  tenantId: string;

  issuer: {
    operator: string | null;
    operatorPublicKey: string | null;
    gateway: {
      host: string | null;
      url: string | null;
      softwareVersion: string;
    };
    trustAnchor: 'self-asserted-arweave-wallet';
    independence: 'third-party-from-data-owner';
  };

  subject: {
    input: { type: 'txIds'; ids: string[] };
    network: 'arweave-mainnet';
    totalCount: number;
  };

  methodology: {
    checks: string[];
    signatureAlgorithms: string[];
    deepHashSpec: string;
    canonicalization: 'RFC8785';
    assuranceLevel: 'cryptographic-proof';
    knownLimitations: string[];
    referenceVerifier: string;
  };

  results: {
    verified: BundleVerifiedEntry[];
    failed: BundleFailedEntry[];
    verifiedTruncated: boolean;
    failuresTruncated: boolean;
    txMerkleRoot: string;
    totals: {
      verified: number;
      tampered: number;
      unavailable: number;
      cacheHit: number;
      bytesFetched: number;
      total: number;
    };
  };

  validity: {
    producedAt: string;
    validFrom: string;
    validUntil: string;
    retentionPolicy: string;
    timeSource: 'system-clock';
  };

  humanReadable: {
    summary: string;
    limitations: string;
    howToReverify: string;
  };

  conformance: string[];

  payloadHash: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signature: string | null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildBundle(jobId: string, runId: string): VerificationBundleV2 | null {
  const job = jobs.findJobById(jobId);
  const run = jobs.getRun(runId);
  if (!job || !run) return null;

  const verifiedRows = jobs.listVerifiedForRun(run.id, ENTRY_CAP + 1);
  const verifiedTruncated = verifiedRows.length > ENTRY_CAP;
  const failureRows = jobs.listFailuresForRun(run.id, ENTRY_CAP + 1);
  const failuresTruncated = failureRows.length > ENTRY_CAP;

  const verified: BundleVerifiedEntry[] = [];
  for (const row of verifiedRows.slice(0, ENTRY_CAP)) {
    if (!row.resultJson) {
      logger.warn(
        { runId: run.id, txId: row.txId },
        'Verified row missing cached VerificationResult — skipping from bundle'
      );
      continue;
    }
    try {
      const r = JSON.parse(row.resultJson) as VerificationResult;
      verified.push(projectVerified(r, row.verificationId));
    } catch (err) {
      logger.warn(
        { err, runId: run.id, txId: row.txId },
        'Failed to parse cached VerificationResult — skipping from bundle'
      );
    }
  }

  const failed: BundleFailedEntry[] = failureRows.slice(0, ENTRY_CAP).map((f) => ({
    txId: f.txId,
    outcome: f.outcome as 'unavailable' | 'tampered',
    failureReason: f.failureReason,
    verificationId: f.verificationId,
  }));

  // `producedAt` is sourced from the run's finishedAt (or startedAt if the
  // run is still in flight) so rebuilding the bundle for the same run is
  // byte-identical — critical for signature stability and for verifiers that
  // re-canonicalize on receive.
  const producedAtMs = run.finishedAt ?? run.startedAt ?? Date.now();
  const producedAt = new Date(producedAtMs);
  // Defensive default so tests that mock config without
  // BUNDLE_RETENTION_MONTHS still build a valid bundle.
  const retentionMonths = config.BUNDLE_RETENTION_MONTHS ?? 6;
  const validUntil = new Date(producedAt);
  validUntil.setMonth(validUntil.getMonth() + retentionMonths);

  // Merkle root binds every enumerated per-tx entry to a single hash inside
  // the signed payload, so a third party can prove inclusion of any single
  // tx without holding the entire bundle. Verifieds first, then faileds,
  // each canonicalised individually (RFC 8785) then SHA-256'd as a leaf.
  const merkleLeaves: string[] = [];
  for (const v of verified)
    merkleLeaves.push(canonicalize(v as unknown as Record<string, unknown>));
  for (const f of failed) merkleLeaves.push(canonicalize(f as unknown as Record<string, unknown>));
  const txMerkleRoot = merkleRootFromCanonicalEntries(merkleLeaves);

  const verifiedCount = run.verifiedCount;
  const totalCount = job.totalCount;
  const summary = humanReadableSummary({
    verified: verifiedCount,
    total: totalCount,
    tampered: run.failedCount,
    unavailable: run.unavailableCount,
  });

  const bundle: VerificationBundleV2 = {
    $schema: BUNDLE_SCHEMA_URL,
    '@context': BUNDLE_CONTEXT_URL,
    type: BUNDLE_TYPE,
    version: BUNDLE_VERSION,

    id: `urn:ar-io-verify:${job.id}:${run.id}`,
    jobId: job.id,
    runId: run.id,
    tenantId: job.tenantId,

    issuer: {
      operator: getOperatorAddress(),
      operatorPublicKey: getOperatorPublicKey(),
      gateway: {
        host: config.GATEWAY_HOST || null,
        url: config.GATEWAY_URL || null,
        softwareVersion: SERVER_VERSION,
      },
      trustAnchor: 'self-asserted-arweave-wallet',
      independence: 'third-party-from-data-owner',
    },

    subject: {
      input: { type: 'txIds', ids: job.inputSpec.ids },
      network: 'arweave-mainnet',
      totalCount,
    },

    methodology: {
      checks: ['existence', 'data_hash_sha256', 'signature_deep_hash'],
      signatureAlgorithms: ['RSA-PSS-SHA256', 'Ed25519', 'ECDSA-secp256k1'],
      deepHashSpec: 'ANS-104',
      canonicalization: CANONICALIZATION_SPEC,
      assuranceLevel: 'cryptographic-proof',
      knownLimitations: KNOWN_LIMITATIONS,
      referenceVerifier: REFERENCE_VERIFIER_URL,
    },

    results: {
      verified,
      failed,
      verifiedTruncated,
      failuresTruncated,
      txMerkleRoot,
      totals: {
        verified: run.verifiedCount,
        tampered: run.failedCount,
        unavailable: run.unavailableCount,
        cacheHit: run.cacheHitCount,
        bytesFetched: run.bytesFetched,
        total: totalCount,
      },
    },

    validity: {
      producedAt: producedAt.toISOString(),
      validFrom: producedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      retentionPolicy: `P${retentionMonths}M`,
      timeSource: 'system-clock',
    },

    humanReadable: {
      summary,
      limitations:
        'This report makes no claim about the meaning, legality, or fitness-for-purpose ' +
        'of the verified data — only its cryptographic integrity and the on-chain ' +
        'existence of the transactions listed in `subject.input.ids`. No verification ' +
        'beyond `methodology.checks` was performed. The `signedAt`/`producedAt` timestamps ' +
        'are taken from the operator’s system clock and are not anchored to a trusted ' +
        'timestamp authority — operator-clock backdating is not defended against by this ' +
        'bundle version.',
      howToReverify:
        'Run: `npx @ar-io/verifier-cli reverify <this-bundle.json>` — or follow the ' +
        'recipe in `docs/COMPLIANCE.md`. The verifier needs only this JSON and Node ≥18.',
    },

    conformance: BUNDLE_CONFORMANCE,

    payloadHash: '',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signature: null,
  };

  // Compute payloadHash + signature over the canonical bundle minus the
  // two fields they themselves carry (chicken-and-egg).
  const { payloadHash: _ph, signature: _sig, ...unsigned } = bundle;
  const canonical = canonicalize(unsigned as unknown as Record<string, unknown>);
  bundle.payloadHash = sha256B64Url(Buffer.from(canonical));

  if (isSigningEnabled()) {
    bundle.signature = signPayload(unsigned as unknown as Record<string, unknown>);
  }

  return bundle;
}

/**
 * Serialize a bundle to its canonical-JSON form (RFC 8785). This is what
 * gets stored and what verifiers should reconstruct.
 */
export function bundleToCanonicalJson(bundle: VerificationBundleV2): string {
  return canonicalize(bundle as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Projection + helpers
// ---------------------------------------------------------------------------

function projectVerified(
  r: VerificationResult,
  verificationId: string | null
): BundleVerifiedEntry {
  return {
    txId: r.txId,
    level: r.level,
    dataSha256: r.authenticity.dataHash,
    dataRoot: r.authenticity.dataRoot ?? null,
    signatureType: r.authenticity.signatureType ?? null,
    owner: r.owner.address,
    blockHeight: r.existence.blockHeight,
    blockTimestamp: r.existence.blockTimestamp,
    isBundled: r.bundle.isBundled,
    bundleRootTxId: r.bundle.rootTransactionId,
    // Default for cache rows that pre-date the recovery commit — they're
    // structurally pre-V2 and may not carry the recovery block. Schema
    // declares recovery as required; this default keeps the bundle
    // conformant even on legacy cache hits.
    recovery: r.recovery ?? { arweave: null, dataItem: null },
    verificationId,
  };
}

function humanReadableSummary(t: {
  verified: number;
  total: number;
  tampered: number;
  unavailable: number;
}): string {
  if (t.total === 0) {
    return 'This bundle attests that the operator ran a verification job with no transactions.';
  }
  const pct = ((t.verified / t.total) * 100).toFixed(0);
  const parts = [
    `This report attests that ${t.verified} of ${t.total} transactions (${pct}%) were ` +
      'cryptographically verified as untampered, with valid signatures bound to their stated ' +
      'owners on the Arweave blockweave.',
  ];
  if (t.tampered > 0) {
    parts.push(
      `${t.tampered} transaction(s) were observed as TAMPERED — the data served did not match ` +
        'the on-chain signature. These represent integrity violations and are listed in ' +
        '`results.failed`.'
    );
  }
  if (t.unavailable > 0) {
    parts.push(
      `${t.unavailable} transaction(s) could not be retrieved from the serving gateway and ` +
        'were not verified. `results.failed[].failureReason` carries the granular cause.'
    );
  }
  parts.push(
    'Per-tx evidence is enumerated under `results.verified` and `results.failed`, with each ' +
      'row independently re-derivable from the originating tx. A Merkle root over every ' +
      'enumerated row is bound to this bundle via `results.txMerkleRoot`, so individual ' +
      'inclusion can be proven without holding the whole bundle.'
  );
  return parts.join(' ');
}
