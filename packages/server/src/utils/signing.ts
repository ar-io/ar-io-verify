import { createHash, createSign, constants as cryptoConstants } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from './logger.js';
import { base64UrlToBuffer, bufferToBase64Url, sha256B64Url } from './crypto.js';
import type { VerificationResult } from '../types.js';

interface JWK {
  kty: string;
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
}

let jwk: JWK | null = null;
let operatorAddress: string | null = null;
let privatePem: string | null = null;

/**
 * Initialize the signing module. Call once on startup.
 * If SIGNING_KEY_PATH is not set or the file doesn't exist, signing is disabled.
 */
export function initSigning(): boolean {
  const keyPath = config.SIGNING_KEY_PATH;
  if (!keyPath) {
    logger.info('No SIGNING_KEY_PATH configured — attestation signing disabled');
    return false;
  }

  if (!existsSync(keyPath)) {
    logger.warn({ keyPath }, 'SIGNING_KEY_PATH file not found — attestation signing disabled');
    return false;
  }

  try {
    const raw = readFileSync(keyPath, 'utf-8');
    jwk = JSON.parse(raw);

    if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.d) {
      logger.error('Invalid JWK — must be RSA with private key (d field)');
      jwk = null;
      return false;
    }

    // Derive operator address: base64url(SHA-256(base64url_decode(n)))
    const nBytes = base64UrlToBuffer(jwk.n);
    const hash = createHash('sha256').update(nBytes).digest();
    operatorAddress = bufferToBase64Url(hash);

    // Build PEM private key
    privatePem = jwkToPem(jwk);

    logger.info({ operatorAddress }, 'Attestation signing enabled');
    return true;
  } catch (error) {
    logger.error({ error }, 'Failed to load signing key');
    jwk = null;
    return false;
  }
}

export function isSigningEnabled(): boolean {
  return jwk !== null && privatePem !== null;
}

export function getOperatorAddress(): string | null {
  return operatorAddress;
}

export function getOperatorPublicKey(): string | null {
  return jwk?.n ?? null;
}

/**
 * Build the canonical attestation payload from a verification result.
 * Only includes the claims the operator is standing behind.
 * Keys are sorted alphabetically for deterministic hashing.
 */
export function buildAttestationPayload(
  result: VerificationResult,
  gateway: string
): Record<string, unknown> {
  return {
    attestedAt: new Date().toISOString(),
    blockHeight: result.existence.blockHeight,
    blockTimestamp: result.existence.blockTimestamp,
    dataHash: result.authenticity.dataHash,
    dataSize: result.metadata.dataSize,
    gateway,
    operator: operatorAddress,
    ownerAddress: result.owner.address,
    signatureVerified: result.authenticity.signatureValid === true,
    txId: result.txId,
    version: 1,
  };
}

/**
 * Canonicalize a payload to deterministic JSON (sorted keys, no whitespace).
 */
export function canonicalize(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/**
 * Sign an attestation payload with the operator's private key.
 * Returns the base64url-encoded RSA-PSS signature.
 */
export function signPayload(payload: Record<string, unknown>): string | null {
  if (!privatePem) return null;

  const canonical = canonicalize(payload);

  const signer = createSign('sha256');
  signer.update(canonical);

  const signature = signer.sign({
    key: privatePem,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_AUTO,
  });

  return bufferToBase64Url(signature);
}

/**
 * Build and sign a complete attestation for a verification result.
 */
export function createAttestation(result: VerificationResult): VerificationResult['attestation'] {
  if (!isSigningEnabled() || !operatorAddress) return null;

  const gateway = config.GATEWAY_HOST || 'unknown';
  const payload = buildAttestationPayload(result, gateway);
  const canonical = canonicalize(payload);
  const payloadHash = sha256B64Url(Buffer.from(canonical));
  const signature = signPayload(payload);

  if (!signature) return null;

  return {
    operator: operatorAddress,
    gateway,
    signature,
    payloadHash,
    payload,
    attestedAt: payload.attestedAt as string,
  };
}

// ---------------------------------------------------------------------------
// JWK to PEM conversion (RSA private key)
// ---------------------------------------------------------------------------

function jwkToPem(key: JWK): string {
  // Convert JWK fields to buffers
  const n = base64UrlToBuffer(key.n);
  const e = base64UrlToBuffer(key.e);
  const d = base64UrlToBuffer(key.d);
  const p = base64UrlToBuffer(key.p);
  const q = base64UrlToBuffer(key.q);
  const dp = base64UrlToBuffer(key.dp);
  const dq = base64UrlToBuffer(key.dq);
  const qi = base64UrlToBuffer(key.qi);

  // DER-encode RSAPrivateKey
  const version = Buffer.from([0x02, 0x01, 0x00]); // INTEGER 0
  const body = Buffer.concat([
    version,
    derInteger(n),
    derInteger(e),
    derInteger(d),
    derInteger(p),
    derInteger(q),
    derInteger(dp),
    derInteger(dq),
    derInteger(qi),
  ]);
  const seq = derSequence(body);

  const b64 = seq.toString('base64');
  const lines = b64.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines}\n-----END RSA PRIVATE KEY-----`;
}

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  if (length < 256) return Buffer.from([0x81, length]);
  if (length < 65536) return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.from([0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

function derInteger(data: Buffer): Buffer {
  const padded = data[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), data]) : data;
  return Buffer.concat([Buffer.from([0x02]), derLength(padded.length), padded]);
}

function derSequence(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(data.length), data]);
}
