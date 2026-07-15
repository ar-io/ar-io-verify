import { createHash, createSign, constants as cryptoConstants } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from './logger.js';
import { base64UrlToBuffer, bufferToBase64Url, sha256B64Url } from './crypto.js';
import type { VerificationResult } from '../types.js';
// RFC 8785 (JCS) canonicalization — the same reference implementation the
// @ar.io/proof family kernels use (see ar-io-proof ts/src/verifier.ts). Aliased
// so this module can keep exporting a `canonicalize()` wrapper of its own.
import jcsCanonicalize from 'canonicalize';

/**
 * Self-identifier for the attestation payload schema (evidence-export.md §3.1).
 * Body-internal only — the record `signature_alg` + the spec are authoritative.
 */
export const ATTESTATION_VERSION = 'ario.evidence.attestation/v1';

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
 * A `subject_ref` binds an attestation to an external subject by hash + type
 * without disclosing its bytes (evidence-export.md §3.2). Additive-optional:
 * absent ⇒ the attestation binds only to the on-chain tx.
 */
export interface AttestationSubjectRef {
  hash: string;
  type: string;
}

/**
 * The attested data's SHA-256 as LOWERCASE HEX for the signed payload
 * (evidence-export.md §3.1). The kernel binds `data_hash` by string-comparing
 * it to `SHA-256(JCS(checkpoint.envelope))` in lowercase hex, and `data_hash`
 * sits inside the signature — so it MUST be signed as hex; it can't be fixed
 * downstream in the composer. The pipeline already computed the digest as
 * base64url (`result.authenticity.dataHash`); transcode the same 32 digest
 * bytes to hex (no recomputation). `null` when no data was fetched.
 */
function dataHashToHex(dataHashB64Url: string | null): string | null {
  if (!dataHashB64Url) return null;
  return base64UrlToBuffer(dataHashB64Url).toString('hex');
}

/**
 * Build the attestation payload from a verification result.
 *
 * Field names are the family `snake_case` form (evidence-export.md §3.1); the
 * payload is signed over its JCS (RFC 8785) canonicalization (§3.3), so the
 * insertion order here is irrelevant — JCS sorts keys. Only the claims the
 * operator is standing behind are included; the record's signature fields are
 * NOT part of the signed payload.
 */
export function buildAttestationPayload(
  result: VerificationResult,
  gateway: string,
  subjectRef?: AttestationSubjectRef
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    attestation_version: ATTESTATION_VERSION,
    attested_at: new Date().toISOString(),
    block_height: result.existence.blockHeight,
    block_timestamp: result.existence.blockTimestamp,
    data_hash: dataHashToHex(result.authenticity.dataHash),
    data_size: result.metadata.dataSize,
    gateway,
    level: result.level,
    operator: operatorAddress,
    owner_address: result.owner.address,
    signature_verified: result.authenticity.signatureValid === true,
    tx_id: result.txId,
  };

  // Additive-optional (§3.2): emit only when supplied so a subject-less
  // attestation stays byte-identical to one built without the argument.
  if (subjectRef) {
    payload.subject_ref = { hash: subjectRef.hash, type: subjectRef.type };
  }

  return payload;
}

/**
 * Canonicalize a payload to its RFC 8785 (JCS) form.
 *
 * Migrated (evidence-export.md §3.4) off the previous custom deep-sorted-key
 * canon onto JCS so the @ar.io/proof kernels verify attestations with their
 * existing canonicalizer (no second canon to maintain). Wraps the same
 * `canonicalize` reference implementation the family's `jcs()` uses, with the
 * identical discipline: reject lone UTF-16 surrogates on the INPUT (RFC 8785
 * requires well-formed UTF-8; the sibling kernels cannot represent them), and
 * reject a non-string result.
 */
export function canonicalize(payload: Record<string, unknown>): string {
  rejectLoneSurrogates(payload);
  const canonical = jcsCanonicalize(payload);
  if (typeof canonical !== 'string') {
    throw new Error('canonicalize: JCS returned a non-string (input not JSON-serializable?)');
  }
  return canonical;
}

// Walk every string in the value (keys and values). The check must run on the
// INPUT: `canonicalize` escapes a lone surrogate as `\udXXX` text in its
// output, so the malformed code unit is invisible after serialization.
function rejectLoneSurrogates(value: unknown): void {
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new Error(
        'canonicalize: input contains a lone UTF-16 surrogate (not representable as UTF-8)'
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) rejectLoneSurrogates(v);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      rejectLoneSurrogates(k);
      rejectLoneSurrogates(v);
    }
  }
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid pair
        continue;
      }
      return true; // high surrogate without a low
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true; // low surrogate without a high
  }
  return false;
}

/**
 * Sign a payload with the operator's private key.
 *
 * Signs RSA-PSS over SHA-256 (MGF1-SHA-256) of the JCS (RFC 8785)
 * canonicalization of the payload, with salt length = 32 bytes
 * (RSA_PSS_SALTLEN_DIGEST) per evidence-export.md §3.3. Returns the
 * base64url-encoded signature.
 */
export function signPayload(payload: Record<string, unknown>): string | null {
  if (!privatePem) return null;

  const canonical = canonicalize(payload);

  const signer = createSign('sha256');
  signer.update(canonical);

  const signature = signer.sign({
    key: privatePem,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    // Pinned salt = digest length (32 bytes), RSA_PSS_SALTLEN_DIGEST
    // (evidence-export.md §3.3). The former RSA_PSS_SALTLEN_AUTO resolves to the
    // maximum key-size-dependent salt on *signing*, which WebCrypto and Python
    // `cryptography` cannot verify (neither auto-detects salt). saltLength=32 is
    // what makes the kernel's verifyRsaPssSha256 (WebCrypto, saltLength:32)
    // round-trip. NOTE: SIGNING path only — the Arweave data-item VERIFY path in
    // crypto.ts deliberately keeps _AUTO (accepts arweave-js salt=0/32).
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
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
    attestedAt: payload.attested_at as string,
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
