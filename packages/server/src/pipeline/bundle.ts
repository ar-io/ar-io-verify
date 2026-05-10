import { config } from '../config.js';
import {
  canonicalize,
  getOperatorAddress,
  getOperatorPublicKey,
  isSigningEnabled,
  signPayload,
} from '../utils/signing.js';
import { sha256B64Url } from '../utils/crypto.js';
import * as jobs from '../storage/jobs.js';

/**
 * Bound on how many failure rows are embedded directly in the bundle.
 * Anything beyond this is queryable via GET /api/v1/jobs/:id/results — keeping
 * the bundle compact matters more for downstream tooling than completeness.
 */
const FAILURE_CAP = 1000;

export const BUNDLE_VERSION = 1;
export const BUNDLE_TYPE = 'verify.bundle.run';

export interface VerificationBundleV1 {
  version: 1;
  type: 'verify.bundle.run';
  jobId: string;
  runId: string;
  tenantId: string;
  operator: string | null;
  operatorPublicKey: string | null;
  gateway: string | null;
  startedAt: string;
  finishedAt: string;
  input: { type: 'txIds'; ids: string[] };
  totals: {
    verified: number;
    tampered: number;
    unavailable: number;
    cacheHit: number;
    bytesFetched: number;
    total: number;
  };
  deltas: {
    verified: number;
    tampered: number;
    unavailable: number;
  } | null;
  failures: Array<{
    txId: string;
    outcome: string;
    failureReason: string | null;
    verificationId: string | null;
  }>;
  failuresTruncated: boolean;
  payloadHash: string;
  signature: string | null;
}

/**
 * Build a signed verification bundle for a completed run.
 *
 * The bundle is the primary verifiable artifact — machine-verifiable offline
 * using only the operator's public key. Verifiers reconstruct the canonical
 * JSON of the bundle minus the `signature` field, then verify RSA-PSS-SHA256
 * against the operator's public key.
 *
 * Returns null if the job or run can't be found.
 */
export function buildBundle(jobId: string, runId: string): VerificationBundleV1 | null {
  const job = jobs.findJobById(jobId);
  const run = jobs.getRun(runId);
  if (!job || !run) return null;

  const failures = jobs.listFailuresForRun(runId, FAILURE_CAP + 1);
  const truncated = failures.length > FAILURE_CAP;
  const cappedFailures = truncated ? failures.slice(0, FAILURE_CAP) : failures;

  // Deltas vs the previous completed run (post-MVP, when scheduled jobs land).
  // Leave null on initial implementation to keep the bundle schema stable.
  const deltas: VerificationBundleV1['deltas'] = null;

  const bundle: VerificationBundleV1 = {
    version: 1,
    type: BUNDLE_TYPE,
    jobId: job.id,
    runId: run.id,
    tenantId: job.tenantId,
    operator: getOperatorAddress(),
    operatorPublicKey: getOperatorPublicKey(),
    gateway: config.GATEWAY_HOST || null,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: new Date(run.finishedAt ?? Date.now()).toISOString(),
    input: { type: 'txIds', ids: job.inputSpec.ids },
    totals: {
      verified: run.verifiedCount,
      tampered: run.failedCount,
      unavailable: run.unavailableCount,
      cacheHit: run.cacheHitCount,
      bytesFetched: run.bytesFetched,
      total: job.totalCount,
    },
    deltas,
    failures: cappedFailures.map((f) => ({
      txId: f.txId,
      outcome: f.outcome,
      failureReason: f.failureReason,
      verificationId: f.verificationId,
    })),
    failuresTruncated: truncated,
    payloadHash: '',
    signature: null,
  };

  // Compute payloadHash + signature over the canonical bundle minus those two
  // fields (otherwise we'd be hashing/signing a chicken-and-egg).
  const { payloadHash: _ph, signature: _sig, ...unsigned } = bundle;
  const canonical = canonicalize(unsigned as unknown as Record<string, unknown>);
  bundle.payloadHash = sha256B64Url(Buffer.from(canonical));

  if (isSigningEnabled()) {
    bundle.signature = signPayload(unsigned as unknown as Record<string, unknown>);
  }

  return bundle;
}

/**
 * Serialize a bundle to its canonical-JSON form (sorted keys recursively, no
 * whitespace). This is what gets stored and what verifiers should reconstruct.
 */
export function bundleToCanonicalJson(bundle: VerificationBundleV1): string {
  return canonicalize(bundle as unknown as Record<string, unknown>);
}
