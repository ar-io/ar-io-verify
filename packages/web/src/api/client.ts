export interface VerificationResult {
  verificationId: string;
  timestamp: string;
  txId: string;
  level: 1 | 2 | 3;

  existence: {
    status: 'confirmed' | 'pending' | 'not_found';
    blockHeight: number | null;
    blockTimestamp: string | null;
    blockId: string | null;
    confirmations: number | null;
  };

  authenticity: {
    status: 'signature_verified' | 'hash_verified' | 'unverified';
    signatureValid: boolean | null;
    signatureSkipReason: string | null;
    dataHash: string | null;
    gatewayHash: string | null;
    hashMatch: boolean | null;
  };

  owner: {
    address: string | null;
    publicKey: string | null;
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

  gatewayAssessment: {
    verified: boolean | null;
    stable: boolean | null;
    trusted: boolean | null;
    hops: number | null;
  };

  links: {
    dashboard: string | null;
    pdf: string | null;
    rawData: string | null;
  };
}

function getBase(): string {
  const path = window.location.pathname;
  const match = path.match(/(.*\/verify)(\/|$)/);
  return match ? match[1] : '/verify';
}
const BASE = getBase();

export async function verifyTransaction(txId: string): Promise<VerificationResult> {
  const res = await fetch(`${BASE}/api/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getVerification(id: string): Promise<VerificationResult> {
  const res = await fetch(`${BASE}/api/v1/verify/${id}`);
  if (!res.ok) {
    throw new Error(`Verification not found`);
  }
  return res.json();
}

export function getPdfUrl(id: string): string {
  return `${BASE}/api/v1/verify/${id}/pdf`;
}

let cachedConfig: { publicGatewayUrl: string } | null = null;
export async function getRuntimeConfig(): Promise<{ publicGatewayUrl: string }> {
  if (cachedConfig) return cachedConfig;
  try {
    const res = await fetch(`${BASE}/api/config`);
    if (res.ok) {
      cachedConfig = await res.json();
      return cachedConfig!;
    }
  } catch {
    // fall through
  }
  cachedConfig = { publicGatewayUrl: 'https://turbo-gateway.com' };
  return cachedConfig;
}
