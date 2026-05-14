/**
 * Shared compliance metadata surfaced on every artifact (bundle JSON +
 * single-tx PDF + attestation). Keeping these in one module makes sure
 * the PDF and the JSON tell the same story to an auditor — the JSON's
 * `conformance` array and the PDF's "Conformance" footer must not drift.
 */

export const REFERENCE_VERIFIER_URL =
  'https://github.com/ar-io/ar-io-verify/tree/main/packages/verifier-cli';

export const BUNDLE_CONFORMANCE = [
  'eu-ai-act-art-10-12-13-19-aligned',
  'vc-2.0-structural',
  'c2pa-2.x-aligned',
  'rfc-8785-canonical-json',
];

export const SIGNATURE_ALGORITHM = 'RSA-PSS-SHA256';
export const CANONICALIZATION_SPEC = 'RFC8785';

export const KNOWN_LIMITATIONS = [
  'Ethereum ECDSA (signature type 3) may not verify all signer implementations.',
  'L1/L2 detection reflects the serving gateway’s view, not absolute on-chain state.',
  'unavailable outcomes are not cached — re-runs retry, not replay the last failure.',
];

export const PDF_LIMITATIONS_PARAGRAPH =
  'This certificate makes no claim about the meaning, legality, or fitness-for-purpose ' +
  'of the data it describes — only its cryptographic integrity, on-chain existence, and ' +
  'the verification outcomes recorded in the Evidence Summary table. The producedAt and ' +
  'attestedAt timestamps are taken from the operator’s system clock and are not anchored ' +
  'to a trusted timestamp authority (RFC 3161); operator-clock backdating is not defended ' +
  'against by this report version. This service does not interpret the data, evaluate its ' +
  'compliance with any specific regulation, or issue a professional assurance opinion.';

export const PDF_HOW_TO_REVERIFY_PARAGRAPH =
  'A third party can re-verify this certificate offline using only the operator’s public ' +
  'key. The recipe: (1) extract the attestation payload from this PDF, (2) canonicalize it ' +
  `via ${CANONICALIZATION_SPEC} (sorted keys, no whitespace), (3) SHA-256 the canonical bytes ` +
  'and compare to Payload Hash, (4) verify the RSA-PSS-SHA256 signature against the embedded ' +
  `operator public key. A reference verifier is at ${REFERENCE_VERIFIER_URL}.`;

export const COMPLIANCE_FOOTER =
  `Conformance: ${BUNDLE_CONFORMANCE.join(', ')}. Canonicalization: ${CANONICALIZATION_SPEC}. ` +
  `Signature: ${SIGNATURE_ALGORITHM}.`;
