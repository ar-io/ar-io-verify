import { createHash } from 'node:crypto';
import { bufferToBase64Url } from './crypto.js';

/**
 * Compute a binary SHA-256 Merkle root over an ordered list of leaf hashes.
 *
 * Used to bind every per-tx canonical entry in a verification bundle to a
 * single root hash inside the operator-signed payload. Auditors can then
 * prove inclusion of any individual tx by re-hashing it and walking up
 * with the sibling path — without needing the entire bundle.
 *
 * Construction (the simple, RFC 6962-style minus its domain-separation tag):
 *   - Each leaf is SHA-256(canonical-bytes).
 *   - At each level, pair adjacent hashes left-to-right and SHA-256 the
 *     concatenation.
 *   - If a level has an odd count, the last hash is paired with itself
 *     (duplicated up) — same convention as Bitcoin and Arweave's data_root.
 *   - Empty input → 32 zero bytes' SHA-256 fingerprint, encoded base64url.
 *
 * Returns the root encoded base64url so it slots straight into canonical
 * JSON without quoting tricks.
 */
export function merkleRoot(leafHashes: Buffer[]): string {
  if (leafHashes.length === 0) {
    // SHA-256 of the empty byte sequence — a stable, well-known constant.
    // Different from "no leaves" semantically but a verifier can detect the
    // empty case by inspecting `results.totals.total === 0`.
    return bufferToBase64Url(createHash('sha256').update(Buffer.alloc(0)).digest());
  }

  let level = leafHashes;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(
        createHash('sha256')
          .update(Buffer.concat([left, right]))
          .digest()
      );
    }
    level = next;
  }
  return bufferToBase64Url(level[0]);
}

/**
 * Convenience wrapper: given the canonical JSON string of each per-tx
 * entry, compute leaf hashes and the Merkle root. Keeping the leaf step
 * in one place ensures the reference verifier reproduces it byte-identical.
 */
export function merkleRootFromCanonicalEntries(canonicalEntries: string[]): string {
  const leaves = canonicalEntries.map((s) => createHash('sha256').update(s, 'utf8').digest());
  return merkleRoot(leaves);
}
