/** Response from GET /tx/{txId} */
export interface GatewayTransaction {
  format: number;
  id: string;
  last_tx: string;
  owner: string;
  tags: Array<{ name: string; value: string }>;
  target: string;
  quantity: string;
  data_root: string;
  data_size: string;
  reward: string;
  signature: string;
}

/** Parsed headers from HEAD /raw/{txId} */
export interface RawDataHeaders {
  digest: string | null;
  rootTransactionId: string | null;
  contentType: string | null;
  contentLength: number | null;

  // Arweave cryptographic headers
  signature: string | null;
  owner: string | null;
  ownerAddress: string | null;
  signatureType: number | null;
  anchor: string | null;

  // Tags parsed from x-arweave-tag-* headers (decoded name/value pairs)
  tags: Array<{ name: string; value: string }>;
  tagCount: number | null;

  // Data item offset info (for fetching the binary header from the root bundle)
  dataItemOffset: number | null;
  dataItemDataOffset: number | null;

  // Gateway trust assessment headers
  arIoVerified: boolean | null;
  arIoStable: boolean | null;
  arIoTrusted: boolean | null;
  arIoHops: number | null;
  arIoDataId: string | null;
}
