import { createHash, createPublicKey, verify, constants as cryptoConstants } from 'node:crypto';
import { canonicalize } from './canonical.mjs';
import { merkleRootFromCanonicalEntries } from './merkle.mjs';

/**
 * Re-verify a VerificationBundleV2 from its JSON.
 *
 * Returns a per-step report so callers can render the failure mode
 * granularly. Throws only on malformed input — everything else surfaces
 * as `ok: false` on one of the steps.
 *
 * The verifier needs nothing from the original verify server — only the
 * bundle JSON. That's the whole point.
 */
export function reverifyBundle(bundle) {
  const steps = [];

  // ---- Step 1: shape ------------------------------------------------------
  const shape = checkShape(bundle);
  steps.push(shape);
  if (!shape.ok) return finalize(steps);

  // ---- Step 2: payloadHash recompute --------------------------------------
  const { payloadHash, signature, ...unsigned } = bundle;
  const canonical = canonicalize(unsigned);
  const recomputed = b64url(createHash('sha256').update(canonical, 'utf8').digest());
  const phStep = {
    name: 'payloadHash matches recomputed SHA-256 of canonical(bundle - {payloadHash, signature})',
    ok: recomputed === payloadHash,
    detail: recomputed === payloadHash ? recomputed : `expected ${payloadHash}, got ${recomputed}`,
  };
  steps.push(phStep);

  // ---- Step 3: Merkle root over per-tx entries ----------------------------
  const merkleLeaves = [];
  for (const v of bundle.results.verified ?? []) merkleLeaves.push(canonicalize(v));
  for (const f of bundle.results.failed ?? []) merkleLeaves.push(canonicalize(f));
  const recomputedRoot = merkleRootFromCanonicalEntries(merkleLeaves);
  steps.push({
    name: 'txMerkleRoot matches recomputed Merkle root over enumerated entries',
    ok: recomputedRoot === bundle.results.txMerkleRoot,
    detail:
      recomputedRoot === bundle.results.txMerkleRoot
        ? recomputedRoot
        : `expected ${bundle.results.txMerkleRoot}, got ${recomputedRoot}`,
  });

  // ---- Step 4: RSA-PSS signature ------------------------------------------
  if (signature && bundle.issuer?.operatorPublicKey) {
    try {
      const pub = createPublicKey({
        key: { kty: 'RSA', n: bundle.issuer.operatorPublicKey, e: 'AQAB' },
        format: 'jwk',
      });
      const ok = verify(
        'sha256',
        Buffer.from(canonical),
        {
          key: pub,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: cryptoConstants.RSA_PSS_SALTLEN_AUTO,
        },
        Buffer.from(signature, 'base64url')
      );
      steps.push({
        name: 'signature verifies as RSA-PSS-SHA256 under issuer.operatorPublicKey',
        ok,
        detail: ok ? 'signature valid' : 'signature did NOT verify',
      });
    } catch (err) {
      steps.push({
        name: 'signature verifies as RSA-PSS-SHA256 under issuer.operatorPublicKey',
        ok: false,
        detail: `signature check threw: ${err.message}`,
      });
    }
  } else if (signature && !bundle.issuer?.operatorPublicKey) {
    steps.push({
      name: 'signature verifies as RSA-PSS-SHA256 under issuer.operatorPublicKey',
      ok: false,
      detail: 'signature present but operatorPublicKey missing — cannot verify',
    });
  } else if (!signature) {
    steps.push({
      name: 'signature verifies as RSA-PSS-SHA256 under issuer.operatorPublicKey',
      ok: false,
      detail:
        'bundle is unsigned (issuer wallet was not configured at run time) — cryptographic ' +
        'attribution to the operator cannot be checked. Other steps may still pass.',
    });
  }

  return finalize(steps);
}

function checkShape(b) {
  const required = [
    '$schema',
    '@context',
    'type',
    'version',
    'id',
    'issuer',
    'subject',
    'methodology',
    'results',
    'validity',
    'humanReadable',
    'conformance',
    'payloadHash',
    'signatureAlgorithm',
  ];
  const missing = required.filter((k) => b[k] === undefined);
  if (missing.length > 0) {
    return {
      name: 'bundle has all required V2 fields',
      ok: false,
      detail: `missing fields: ${missing.join(', ')}`,
    };
  }
  if (b.type !== 'VerificationBundle' || b.version !== 2) {
    return {
      name: 'bundle is type=VerificationBundle, version=2',
      ok: false,
      detail: `got type=${b.type} version=${b.version}`,
    };
  }
  if (b.methodology.canonicalization !== 'RFC8785') {
    return {
      name: 'methodology.canonicalization is RFC8785',
      ok: false,
      detail: `got ${b.methodology.canonicalization}`,
    };
  }
  if (b.signatureAlgorithm !== 'RSA-PSS-SHA256') {
    return {
      name: 'signatureAlgorithm is RSA-PSS-SHA256',
      ok: false,
      detail: `got ${b.signatureAlgorithm}`,
    };
  }
  if (!b.results?.txMerkleRoot) {
    return {
      name: 'bundle has results.txMerkleRoot',
      ok: false,
      detail: 'missing',
    };
  }
  return { name: 'bundle has all required V2 fields', ok: true, detail: 'shape ok' };
}

function finalize(steps) {
  return {
    ok: steps.every((s) => s.ok),
    steps,
  };
}

function b64url(buf) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
