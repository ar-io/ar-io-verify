import { createHash } from 'node:crypto';

// SHA-256 Merkle root with odd-tail duplication. Mirror of
// packages/server/src/utils/merkle.ts.

function b64url(buf) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function merkleRoot(leafHashes) {
  if (leafHashes.length === 0) {
    return b64url(createHash('sha256').update(Buffer.alloc(0)).digest());
  }
  let level = leafHashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(createHash('sha256').update(Buffer.concat([left, right])).digest());
    }
    level = next;
  }
  return b64url(level[0]);
}

export function merkleRootFromCanonicalEntries(canonicalEntries) {
  const leaves = canonicalEntries.map((s) => createHash('sha256').update(s, 'utf8').digest());
  return merkleRoot(leaves);
}
