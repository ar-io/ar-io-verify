import type { VerificationResult } from '../types.js';
import type { ResultOutcome, FailureReason } from '../storage/jobs.js';

export interface OutcomeMapping {
  outcome: ResultOutcome;
  failureReason: FailureReason | null;
}

/**
 * Map a VerificationResult to the coarse-grained job outcome and a granular
 * failure reason. Customers act on these distinctly — lumping signature
 * mismatch with gateway timeout into 'failed' is a downgrade.
 *
 *   verified   = signature math checked out
 *   tampered   = something is provably wrong (signature mismatch, tx id mismatch)
 *   unavailable = couldn't determine — transient gateway issue, missing data, etc.
 */
export function mapOutcome(result: VerificationResult): OutcomeMapping {
  if (
    result.authenticity.status === 'signature_verified' &&
    result.authenticity.signatureValid === true
  ) {
    return { outcome: 'verified', failureReason: null };
  }

  // Pipeline returns signatureValid=false for both signature mismatch and
  // tx-id-mismatch (the substitution check in orchestrator.ts:392-411).
  if (result.authenticity.signatureValid === false) {
    const skipReason = result.authenticity.signatureSkipReason ?? '';
    if (skipReason.includes('Transaction ID mismatch')) {
      return { outcome: 'tampered', failureReason: 'tx_id_mismatch' };
    }
    return { outcome: 'tampered', failureReason: 'signature_mismatch' };
  }

  // signatureValid === null  → couldn't verify. Categorize by skip reason.
  if (result.existence.status === 'not_found') {
    return { outcome: 'unavailable', failureReason: 'gateway_404' };
  }
  const skip = result.authenticity.signatureSkipReason ?? '';
  if (skip.includes('Binary header unavailable')) {
    return { outcome: 'unavailable', failureReason: 'binary_header_unavailable' };
  }
  if (skip.includes('too large') || skip.includes('Maximum supported size')) {
    return { outcome: 'unavailable', failureReason: 'data_too_large' };
  }
  if (skip.includes('Raw data unavailable')) {
    return { outcome: 'unavailable', failureReason: 'raw_data_unavailable' };
  }
  if (
    skip.includes('No signature') ||
    skip.includes('No owner public key') ||
    skip.includes('Only wallet address') ||
    skip.includes('Insufficient data')
  ) {
    return { outcome: 'unavailable', failureReason: 'gateway_signature_unavailable' };
  }
  return { outcome: 'unavailable', failureReason: 'unknown' };
}

/**
 * "Permanent" results never need re-verification — a verified or tampered tx
 * means we have a definitive answer that won't change without re-uploading
 * data to Arweave. Used by the cache to decide what to persist (task #19) and
 * by the worker to decide what to read (defense-in-depth).
 */
export function isPermanentOutcome(result: VerificationResult): boolean {
  const m = mapOutcome(result);
  return m.outcome === 'verified' || m.outcome === 'tampered';
}
