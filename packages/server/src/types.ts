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
    /**
     * Named algorithm that verified the signature, so auditors know which
     * code path produced the proof and can re-verify with the right primitive.
     *
     *   "arweave-tx-rsa-pss" — L1 native Arweave tx (always RSA-PSS over Arweave deep hash)
     *   "ans104-rsa-pss"     — ANS-104 data item, signature type 1
     *   "ans104-ed25519"     — ANS-104 data item, signature type 2 (Solana etc.)
     *   "ans104-ecdsa"       — ANS-104 data item, signature type 3 (Ethereum)
     *   null                 — signature was not verified (skip / fail)
     */
    signatureType:
      | 'arweave-tx-rsa-pss'
      | 'ans104-rsa-pss'
      | 'ans104-ed25519'
      | 'ans104-ecdsa'
      | null;
    /**
     * Arweave L1 format-2 data_root (chunk Merkle root), when applicable.
     * For format-2 L1 transactions, the signature is over a deep hash that
     * includes `dataRoot` — so even when the verifier never downloaded the
     * raw bytes (because they're large or the gateway didn't serve them),
     * `dataRoot` is a non-null cryptographic binding to the data the
     * signer asserted exists. Null for L1 format-1 or L2 data items.
     */
    dataRoot: string | null;
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

  /**
   * Recovery pointers — where this data sits on Arweave such that a
   * customer can re-fetch it directly from the network (not via verify or
   * a specific gateway) and re-verify offline.
   *
   * For L1 native data: `arweave.txId === txId`; `dataItem` is null.
   * For L2 data items:  `arweave.txId === bundle root tx`; `dataItem`
   *   carries the byte offsets within the bundle binary.
   */
  recovery: {
    /** L1 weave-level location of the data (or its parent bundle). */
    arweave: {
      /** The L1 tx whose offset is reported (== txId for L1, == bundle root for L2). */
      txId: string;
      /** Total bytes of the L1 data payload. */
      weaveSize: number;
      /** End byte offset within the weave; range is [offset - size + 1, offset]. */
      weaveOffset: number;
    } | null;
    /** ANS-104 data item offsets within the parent bundle binary. */
    dataItem: {
      /** Byte offset of the data item HEADER start within the bundle. */
      headerOffset: number;
      /** Byte offset where the data item's DATA payload starts within the bundle. */
      dataOffset: number;
      /** Bytes of the data item's data payload. */
      dataSize: number;
    } | null;
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
