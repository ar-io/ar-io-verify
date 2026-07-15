import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  createHash,
  createPublicKey,
  createVerify,
  constants as cryptoConstants,
} from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Generate a test RSA key pair for testing
import { generateKeyPairSync } from 'node:crypto';

const TEST_DIR = join(import.meta.dirname, '../fixtures/tmp');
const TEST_KEY_PATH = join(TEST_DIR, 'test-wallet.json');

function generateTestJWK() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048, // Smaller for test speed
    publicExponent: 65537,
  });

  const jwk = privateKey.export({ format: 'jwk' });
  return jwk;
}

// Set up test key before tests
let testJwk: ReturnType<typeof generateTestJWK>;

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  testJwk = generateTestJWK();
  writeFileSync(TEST_KEY_PATH, JSON.stringify(testJwk));

  // Set env vars before importing config
  process.env.SIGNING_KEY_PATH = TEST_KEY_PATH;
  process.env.GATEWAY_HOST = 'test-gateway.com';
});

// Mock config to use test values
vi.mock('../../src/config.js', () => ({
  config: {
    PORT: 4001,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    GATEWAY_URL: 'http://localhost:9999',
    GATEWAY_TIMEOUT_MS: 5000,
    SQLITE_PATH: ':memory:',
    SIGNING_KEY_PATH: join(import.meta.dirname, '../fixtures/tmp/test-wallet.json'),
    GATEWAY_HOST: 'test-gateway.com',
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));

describe('Signing Module', () => {
  it('initializes with a valid JWK', async () => {
    const { initSigning, isSigningEnabled, getOperatorAddress } =
      await import('../../src/utils/signing.js');
    const result = initSigning();
    expect(result).toBe(true);
    expect(isSigningEnabled()).toBe(true);
    expect(getOperatorAddress()).not.toBeNull();
    expect(getOperatorAddress()!.length).toBe(43);
  });

  it('builds a deterministic snake_case attestation payload', async () => {
    const { buildAttestationPayload, canonicalize, ATTESTATION_VERSION } =
      await import('../../src/utils/signing.js');
    const mockResult = {
      txId: 'test-tx-id-padded-to-43-characters-1234567',
      level: 3,
      authenticity: { dataHash: 'testhash123', signatureValid: true },
      existence: { blockHeight: 100, blockTimestamp: '2024-01-01T00:00:00Z' },
      owner: { address: 'testowner123' },
      metadata: { dataSize: 500 },
    } as any;

    const p1 = buildAttestationPayload(mockResult, 'test.com');
    const p2 = buildAttestationPayload(mockResult, 'test.com');

    // Payload uses family snake_case field names (evidence-export.md §3.1)
    expect(p1.tx_id).toBe('test-tx-id-padded-to-43-characters-1234567');
    expect(p1.data_hash).toBe('testhash123');
    expect(p1.data_size).toBe(500);
    expect(p1.block_height).toBe(100);
    expect(p1.signature_verified).toBe(true);
    expect(p1.owner_address).toBe('testowner123');
    expect(p1.level).toBe(3);
    expect(p1.attestation_version).toBe(ATTESTATION_VERSION);
    expect(p1.gateway).toBe('test.com');
    // Old camelCase names are gone
    expect(p1.txId).toBeUndefined();
    expect(p1.version).toBeUndefined();
    // subject_ref is additive-optional and absent by default (§3.2)
    expect('subject_ref' in p1).toBe(false);

    // Canonical JSON is deterministic (ignoring the attested_at timestamp)
    const c1 = canonicalize({ ...p1, attested_at: 'fixed' });
    const c2 = canonicalize({ ...p2, attested_at: 'fixed' });
    expect(c1).toBe(c2);
    // JCS sorts object keys: attestation_version sorts first
    expect(c1.startsWith('{"attestation_version":')).toBe(true);
  });

  it('signs a payload with an explicit 32-byte (DIGEST) PSS salt over JCS', async () => {
    const { signPayload, canonicalize } = await import('../../src/utils/signing.js');
    const payload = {
      test: 'data',
      version: 1,
    };

    const signature = signPayload(payload);
    expect(signature).not.toBeNull();

    // Round-trip verify: JCS(payload) → createVerify('sha256') → RSA-PSS verify
    // under the PINNED saltLength=32 (RSA_PSS_SALTLEN_DIGEST, evidence-export.md
    // §3.3). Proves the signature is a standard RSA-PSS(SHA-256(canonical)) (not
    // a double hash) AND that it verifies under the fixed 32-byte salt the
    // kernels use — not the old key-size-dependent AUTO/max salt.
    const canonical = canonicalize(payload);
    const sigBuf = Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const pubKey = createPublicKey({ key: testJwk as any, format: 'jwk' });

    const verifier = createVerify('sha256');
    verifier.update(canonical);
    const valid = verifier.verify(
      {
        key: pubKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      sigBuf
    );
    expect(valid).toBe(true);
  });

  it('creates a complete attestation from a verification result', async () => {
    const { createAttestation } = await import('../../src/utils/signing.js');
    const mockResult = {
      txId: 'test-tx-id-padded-to-43-characters-1234567',
      level: 3,
      authenticity: {
        status: 'signature_verified',
        signatureValid: true,
        dataHash: 'testhash',
        gatewayHash: 'testhash',
        hashMatch: true,
        signatureSkipReason: null,
      },
      existence: {
        status: 'confirmed',
        blockHeight: 100,
        blockTimestamp: '2024-01-01T00:00:00Z',
        blockId: null,
      },
      owner: { address: 'testowner', publicKey: null, addressVerified: true },
      metadata: { dataSize: 500, contentType: 'image/png', tags: [] },
      bundle: { isBundled: false, rootTransactionId: null },
      gatewayAssessment: { verified: null, stable: null, trusted: true, hops: 1 },
      attestation: null,
      links: { dashboard: null, pdf: null, rawData: null },
    } as any;

    const attestation = createAttestation(mockResult);
    expect(attestation).not.toBeNull();
    expect(attestation!.operator.length).toBe(43);
    expect(attestation!.gateway).toBe('test-gateway.com');
    expect(attestation!.signature.length).toBeGreaterThan(50);
    expect(attestation!.payloadHash.length).toBe(43);
    expect(attestation!.payload.attestation_version).toBe('ario.evidence.attestation/v1');
    expect(attestation!.payload.tx_id).toBe('test-tx-id-padded-to-43-characters-1234567');
    expect(attestation!.payload.level).toBe(3);
    expect(attestation!.attestedAt).toMatch(/^\d{4}-/);
  });
});

// Cleanup
import { afterAll } from 'vitest';
afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true });
  } catch {}
});
