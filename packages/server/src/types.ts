export interface VerificationResult {
  verificationId: string;
  timestamp: string;
  txId: string;
  /**
   * Verification level based on the strongest proof achieved:
   * 3 = Signature verified (data is authentic — signed by the stated key)
   * 2 = Hash verified (data fingerprint confirmed, but no signature proof)
   * 1 = Existence only (data found, but authenticity unverified)
   */
  level: 1 | 2 | 3;

  existence: {
    status: 'confirmed' | 'pending' | 'not_found';
    blockHeight: number | null;
    blockTimestamp: string | null;
    blockId: string | null;
  };

  /** Authenticity — the primary proof. Signature first, hash as fallback. */
  authenticity: {
    /** Whether the data is proven authentic */
    status: 'signature_verified' | 'hash_verified' | 'unverified';
    /** RSA-PSS signature verified against deep hash of the data */
    signatureValid: boolean | null;
    /** Reason if signature verification was skipped */
    signatureSkipReason: string | null;
    /** SHA-256 fingerprint (independently computed from downloaded raw data) */
    dataHash: string | null;
    /** SHA-256 from gateway x-ar-io-digest header (for comparison) */
    gatewayHash: string | null;
    /** Whether our independent hash matches the gateway's digest */
    hashMatch: boolean | null;
  };

  /** Owner / authorship information */
  owner: {
    address: string | null;
    publicKey: string | null;
    /** Whether SHA-256(publicKey) == address */
    addressVerified: boolean | null;
  };

  metadata: {
    dataSize: number | null;
    contentType: string | null;
    tags: Array<{ name: string; value: string }>;
  };

  bundle: {
    isBundled: boolean;
    rootTransactionId: string | null;
  };

  /** Gateway's own trust assessment from response headers */
  gatewayAssessment: {
    verified: boolean | null;
    stable: boolean | null;
    trusted: boolean | null;
    hops: number | null;
  };

  /** Operator attestation — null if no signing key configured */
  attestation: {
    operator: string;
    gateway: string;
    signature: string;
    payloadHash: string;
    payload: Record<string, unknown>;
    attestedAt: string;
  } | null;

  links: {
    dashboard: string | null;
    pdf: string | null;
    rawData: string | null;
  };
}

export interface VerifyRequest {
  txId: string;
}
