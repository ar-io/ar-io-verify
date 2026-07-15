import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  generateKeyPairSync,
  createSign,
  createHash,
  webcrypto,
  constants as cryptoConstants,
  type KeyObject,
} from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Kernel-compatibility test — the whole point of the JCS + salt migration.
//
// The @ar.io/proof kernels verify an embedded operator attestation with
// RSA-PSS-SHA-256, MGF1-SHA-256, saltLength=32 via WebCrypto
// (git show kernel/rsa-pss-attestation-verify:ts/src/crypto.ts →
// verifyRsaPssSha256). @ar.io/proof is NOT a dependency of ar-io-verify, so we
// replicate the EXACT WebCrypto params the kernel uses rather than importing it.
//
// This proves: (1) a freshly-signed attestation (JCS canon + salt=32) verifies
// under the kernel's saltLength:32 WebCrypto path, and (2) a signature made the
// OLD way (RSA_PSS_SALTLEN_AUTO = max, key-size-dependent salt) over the SAME
// bytes is REJECTED under saltLength:32 — documenting exactly what the migration
// fixes.
// ---------------------------------------------------------------------------

const subtle = webcrypto.subtle;
const RSA_PSS_SALT_LENGTH = 32; // kernel pin (evidence-export.md §3.3)

const tmpDir = mkdtempSync(join(tmpdir(), 'verify-kernel-compat-'));
const keyPath = join(tmpDir, 'wallet.jwk');

// One 2048-bit RSA key used both for the issuer signing module (loaded from the
// JWK file) and for producing the OLD max-salt negative (the KeyObject).
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicExponent: 65537,
});
const privateJwk = privateKey.export({ format: 'jwk' }) as {
  kty: string;
  n: string;
  e: string;
};
writeFileSync(keyPath, JSON.stringify(privateJwk));

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_HOST: 'operator-gateway.example',
    SIGNING_KEY_PATH: keyPath,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Faithful replica of the kernel's hexToBytes (strict charset, even length).
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length string');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('hexToBytes: non-hex characters');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Faithful replica of @ar.io/proof kernel verifyRsaPssSha256: import the JWK RSA
// public key for RSA-PSS/SHA-256, then verify with the PINNED saltLength=32.
async function kernelVerifyRsaPssSha256(
  payloadBytes: Uint8Array,
  signatureHex: string,
  publicKey: { kty: 'RSA'; n: string; e: string }
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);
  const key = await subtle.importKey(
    'jwk',
    { kty: publicKey.kty, n: publicKey.n, e: publicKey.e, ext: true },
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['verify']
  );
  try {
    return await subtle.verify(
      { name: 'RSA-PSS', saltLength: RSA_PSS_SALT_LENGTH },
      key,
      signature,
      payloadBytes
    );
  } catch {
    // A wrong-length RSA signature can throw on some engines — still "not
    // verified," never a crash (same contract as the kernel).
    return false;
  }
}

// Faithful replica of the kernel's deriveOperatorAddress:
// operator = base64url(SHA-256(rawModulusBytes)).
async function kernelDeriveOperatorAddress(nBase64url: string): Promise<string> {
  const b64 = nBase64url.replace(/-/g, '+').replace(/_/g, '/');
  const modulus = Buffer.from(b64, 'base64');
  const digest = new Uint8Array(await subtle.digest('SHA-256', modulus));
  return Buffer.from(digest).toString('base64url');
}

// Faithful replica of the kernel's sha256Hex (WebCrypto → lowercase hex).
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Buffer.from(digest).toString('hex');
}

// The bytes whose SHA-256 the pipeline attested. The orchestrator stores the
// digest as base64url (sha256B64Url); the signed data_hash must be lowercase
// hex, so buildAttestationPayload transcodes those same 32 bytes.
const attestedRawData = Buffer.from('checkpoint envelope JCS bytes — kernel compat');
const attestedDataHashB64 = createHash('sha256').update(attestedRawData).digest('base64url');

const mockResult = {
  txId: 'kernel-compat-tx-id-padded-to-43-chars-01234',
  level: 3,
  authenticity: { dataHash: attestedDataHashB64, signatureValid: true },
  existence: { blockHeight: 1512345, blockTimestamp: '2026-07-15T18:00:00Z' },
  owner: { address: 'owner-address-b64url-000000000000000000000' },
  metadata: { dataSize: 10485760 },
} as unknown as import('../../src/types.js').VerificationResult;

describe('attestation ↔ kernel RSA-PSS compatibility (JCS + salt=32 migration)', () => {
  let signing: typeof import('../../src/utils/signing.js');
  let pubJwk: { kty: 'RSA'; n: string; e: string };

  beforeAll(async () => {
    signing = await import('../../src/utils/signing.js');
    expect(signing.initSigning()).toBe(true);
    expect(signing.isSigningEnabled()).toBe(true);
    pubJwk = { kty: 'RSA', n: privateJwk.n, e: privateJwk.e };
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a freshly-signed attestation verifies under the kernel saltLength=32 path', async () => {
    const payload = signing.buildAttestationPayload(mockResult, 'operator-gateway.example');
    const sigB64Url = signing.signPayload(payload)!;
    expect(sigB64Url).not.toBeNull();

    // The kernel verifies over the raw JCS(payload) bytes with a lowercase-hex
    // signature — mirror that exactly (the issuer emits base64url; decode → hex).
    const payloadBytes = new TextEncoder().encode(signing.canonicalize(payload));
    const sigHex = Buffer.from(sigB64Url, 'base64url').toString('hex');

    const ok = await kernelVerifyRsaPssSha256(payloadBytes, sigHex, pubJwk);
    expect(ok).toBe(true);
  });

  it('data_hash is lowercase hex and round-trips against sha256Hex of the attested bytes', async () => {
    const payload = signing.buildAttestationPayload(mockResult, 'operator-gateway.example');

    // Lowercase hex (§3.1) — the exact string the kernel binds by comparing to
    // SHA-256(JCS(checkpoint.envelope)) in lowercase hex (§5 step 6c).
    expect(payload.data_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.data_hash).toBe(await sha256Hex(attestedRawData));

    // And the attestation carrying that hex data_hash still verifies under the
    // pinned salt=32 — data_hash is inside the signed bytes.
    const payloadBytes = new TextEncoder().encode(signing.canonicalize(payload));
    const sigHex = Buffer.from(signing.signPayload(payload)!, 'base64url').toString('hex');
    expect(await kernelVerifyRsaPssSha256(payloadBytes, sigHex, pubJwk)).toBe(true);
  });

  it('operator address binds to the embedded modulus (base64url(SHA-256(n)))', async () => {
    const payload = signing.buildAttestationPayload(mockResult, 'operator-gateway.example');
    const derived = await kernelDeriveOperatorAddress(pubJwk.n);
    expect(derived).toBe(signing.getOperatorAddress());
    expect(derived).toBe(payload.operator);
  });

  it('the OLD RSA_PSS_SALTLEN_AUTO (max) signature is REJECTED under saltLength=32', async () => {
    const payload = signing.buildAttestationPayload(mockResult, 'operator-gateway.example');
    const canonical = signing.canonicalize(payload);
    const payloadBytes = new TextEncoder().encode(canonical);

    // Reproduce the pre-migration signing exactly: RSA-PSS over the same JCS
    // bytes but with AUTO salt (resolves to the maximum, key-size-dependent salt
    // on signing — 222 bytes for a 2048-bit key, not 32).
    const oldSig = createSign('sha256')
      .update(canonical)
      .sign({
        key: privateKey as KeyObject,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_AUTO,
      });
    const oldSigHex = oldSig.toString('hex');

    // The kernel (saltLength:32) cannot verify a max-salt signature.
    const oldVerifies = await kernelVerifyRsaPssSha256(payloadBytes, oldSigHex, pubJwk);
    expect(oldVerifies).toBe(false);

    // Sanity: the NEW signPayload signature over the same bytes DOES verify —
    // proving the difference is the salt length, nothing else.
    const newSigHex = Buffer.from(signing.signPayload(payload)!, 'base64url').toString('hex');
    const newVerifies = await kernelVerifyRsaPssSha256(payloadBytes, newSigHex, pubJwk);
    expect(newVerifies).toBe(true);
  });
});
