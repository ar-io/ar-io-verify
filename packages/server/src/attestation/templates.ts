import type { VerificationResult } from '../types.js';

/**
 * One-paragraph plain-language summary for the top of the PDF — written
 * for a non-technical auditor under EU AI Act Art. 13 "comprehensible to
 * deployers" and the US Plain Writing Act tone. Mirrors the
 * `humanReadable.summary` block on the batch bundle JSON.
 */
export function plainLanguageSummary(result: VerificationResult): string {
  const ownerNote = result.owner.address
    ? ` The signing owner address is ${result.owner.address}.`
    : '';
  if (result.authenticity.status === 'signature_verified') {
    return (
      'This certificate attests that the Arweave transaction below was found on chain, ' +
      'its data was independently downloaded and SHA-256-fingerprinted, and the on-chain ' +
      'RSA-PSS signature was mathematically verified against that data. This is a ' +
      'cryptographic proof — not an opinion — that the stated owner signed this exact ' +
      'data and that the data has not been modified since.' +
      ownerNote
    );
  }
  if (result.authenticity.status === 'hash_verified') {
    return (
      'This certificate attests that the Arweave transaction below was found on chain ' +
      'and that an independent SHA-256 fingerprint of its data was computed. The full ' +
      'cryptographic signature check could not be completed (see Statement of Facts ' +
      'below for the specific reason). The hash fingerprint is still a meaningful ' +
      'integrity signal but does not by itself prove authorship.' +
      ownerNote
    );
  }
  return (
    'This certificate documents an attempt to verify the Arweave transaction below. ' +
    'Neither the signature nor the data hash check could be completed against this ' +
    'gateway — see Statement of Facts and the Cryptographic Proof Appendix for the ' +
    'granular reason. The data may still exist on Arweave and be verifiable from ' +
    'another peer; this report records what THIS verifier could confirm at the ' +
    'attestedAt time.'
  );
}

/**
 * Honest disclaimer mirroring the bundle's `humanReadable.limitations`.
 * Anchored to ISAE 3000 §69(k) (limited-assurance disclaimer) and EU AI
 * Art. 13(3)(b) "limitations of the system" transparency requirement.
 */
export const PDF_LIMITATIONS = (
  'This report makes no claim about the meaning, legality, or fitness-for-purpose of the ' +
  'data — only its cryptographic integrity and on-chain existence as verified against the ' +
  'serving gateway. Timestamps are taken from the operator’s system clock and are NOT ' +
  'anchored to a trusted timestamp authority (RFC 3161) — operator-clock backdating is ' +
  'not defended against by this report version. Nothing here constitutes legal advice or ' +
  'a professional assurance opinion under ISAE 3000.'
).trim();

/**
 * Reproducibility recipe for an offline third-party verifier. Bundles
 * the same instruction the JSON `humanReadable.howToReverify` field gives.
 */
export const PDF_HOW_TO_REVERIFY = (
  'To re-verify this certificate offline: extract the Attestation Payload JSON below, ' +
  'canonicalize it via RFC 8785 (JCS — sorted keys, no whitespace), SHA-256 the canonical ' +
  'bytes and confirm Payload Hash, then verify the RSA-PSS-SHA256 Signature against the ' +
  'embedded operator public key. A reference verifier is published at ' +
  'github.com/ar-io/ar-io-verify/tree/main/packages/verifier-cli.'
).trim();

/**
 * Render the recovery block for the PDF: where on Arweave this data lives
 * such that the customer can re-fetch it directly from any peer.
 */
export function recoveryStatement(recovery: VerificationResult['recovery']): string[] {
  const lines: string[] = [];
  if (recovery.arweave) {
    lines.push(
      `Weave Pointer: tx ${recovery.arweave.txId}, ` +
        `weave size ${recovery.arweave.weaveSize.toLocaleString()} bytes, ` +
        `weave end-offset ${recovery.arweave.weaveOffset.toLocaleString()}.`
    );
  }
  if (recovery.dataItem) {
    lines.push(
      `Data Item Pointer (within bundle): header offset ${recovery.dataItem.headerOffset.toLocaleString()}, ` +
        `data offset ${recovery.dataItem.dataOffset.toLocaleString()}, ` +
        `data size ${recovery.dataItem.dataSize.toLocaleString()} bytes.`
    );
  }
  if (lines.length === 0) {
    lines.push('No recovery pointer was available from the serving gateway.');
  }
  return lines;
}

export const METHODOLOGY_VERIFIED = `This certificate documents the results of independent cryptographic verification \
performed on data stored on the Arweave blockweave. The data identified by this \
transaction was verified by: (1) confirming transaction existence on the blockchain, \
(2) downloading the raw data and computing its SHA-256 fingerprint, and \
(3) verifying the RSA-PSS cryptographic signature against the deep hash of the data, \
proving the stated owner signed this exact data. All stated facts are the result of \
mathematical computation and cryptographic proof. This service does not make interpretive \
claims about the data's meaning, purpose, or compliance with any particular regulation.`;

export const METHODOLOGY_BASIC = `This certificate documents the results of a verification performed on data \
stored on the Arweave blockweave. The scope of verification was limited because \
either the data has not been fully indexed by this gateway or the full public key \
was not available for signature verification. All stated facts are the result of \
cryptographic proof or direct blockchain query. This service does not make interpretive \
claims about the data's meaning, purpose, or compliance with any particular regulation.`;

export function existenceStatement(
  txId: string,
  blockHeight: number | null,
  blockTimestamp: string | null
): string {
  if (!blockHeight) {
    return `Transaction Existence: Arweave Transaction ${txId} was not found or is pending confirmation.`;
  }
  const ts = blockTimestamp ? ` at ${blockTimestamp}` : '';
  return `Transaction Existence: Arweave Transaction ${txId} exists on the Arweave blockweave, confirmed in block ${blockHeight.toLocaleString()}${ts}.`;
}

export function authenticityStatement(
  auth: VerificationResult['authenticity'],
  owner: VerificationResult['owner']
): string {
  const parts: string[] = [];

  if (auth.status === 'signature_verified') {
    parts.push('Data Authenticity: VERIFIED.');
    parts.push(
      'The RSA-PSS cryptographic signature has been verified against the deep hash of this data item.'
    );
    parts.push(
      'This confirms the stated owner signed this exact data and it has not been modified since.'
    );
  } else if (auth.status === 'hash_verified') {
    parts.push('Data Authenticity: PARTIALLY VERIFIED.');
    parts.push(`SHA-256 fingerprint independently computed: ${auth.dataHash}.`);
    if (auth.signatureSkipReason) {
      parts.push(`Signature verification was not performed: ${auth.signatureSkipReason}.`);
    }
  } else {
    parts.push(
      'Data Authenticity: UNVERIFIED. Neither signature nor hash verification could be performed.'
    );
  }

  if (owner.address) {
    const addrNote = owner.addressVerified ? ' (address derived from public key via SHA-256)' : '';
    parts.push(`Owner: ${owner.address}${addrNote}.`);
  }

  return parts.join(' ');
}

export function bundleStatement(isBundled: boolean, rootTxId: string | null): string {
  if (!isBundled || !rootTxId) return '';
  return `Bundle: This is an ANS-104 bundled data item. Its signature and integrity are verified independently. It is anchored to the Arweave blockchain via root transaction ${rootTxId}.`;
}

export function gatewayAssessmentStatement(
  assessment: VerificationResult['gatewayAssessment'],
  checksPass?: boolean
): string {
  const parts: string[] = [];

  if (!checksPass) {
    if (assessment.verified === true) parts.push('data verified');
    else if (assessment.verified === false) parts.push('data not yet verified');
    if (assessment.stable === true) parts.push('block stable');
    else if (assessment.stable === false) parts.push('block not yet stable');
  }

  if (assessment.trusted === true) parts.push('trusted source');
  if (assessment.hops !== null) parts.push(`${assessment.hops} hop(s)`);

  if (parts.length === 0) return '';
  return `Gateway Assessment: The serving gateway reports: ${parts.join(', ')}.`;
}
