import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { merkleRoot, merkleRootFromCanonicalEntries } from '../../src/utils/merkle.js';
import { bufferToBase64Url } from '../../src/utils/crypto.js';

function sha(...parts: (Buffer | string)[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

describe('merkleRoot', () => {
  it('empty input returns SHA-256 of empty bytes', () => {
    const expected = bufferToBase64Url(sha(Buffer.alloc(0)));
    expect(merkleRoot([])).toBe(expected);
  });

  it('single leaf returns the leaf itself (base64url)', () => {
    const leaf = sha('hello');
    expect(merkleRoot([leaf])).toBe(bufferToBase64Url(leaf));
  });

  it('two leaves: H(a || b)', () => {
    const a = sha('a');
    const b = sha('b');
    expect(merkleRoot([a, b])).toBe(bufferToBase64Url(sha(Buffer.concat([a, b]))));
  });

  it('three leaves: odd-tail duplicates the last hash', () => {
    const a = sha('a');
    const b = sha('b');
    const c = sha('c');
    const ab = sha(Buffer.concat([a, b]));
    const cc = sha(Buffer.concat([c, c]));
    const root = sha(Buffer.concat([ab, cc]));
    expect(merkleRoot([a, b, c])).toBe(bufferToBase64Url(root));
  });

  it('four leaves: balanced pair-up', () => {
    const a = sha('a');
    const b = sha('b');
    const c = sha('c');
    const d = sha('d');
    const ab = sha(Buffer.concat([a, b]));
    const cd = sha(Buffer.concat([c, d]));
    const root = sha(Buffer.concat([ab, cd]));
    expect(merkleRoot([a, b, c, d])).toBe(bufferToBase64Url(root));
  });

  it('order-dependent: swapping leaves changes the root', () => {
    const a = sha('a');
    const b = sha('b');
    expect(merkleRoot([a, b])).not.toBe(merkleRoot([b, a]));
  });

  it('canonical-entry wrapper hashes its inputs then merkles', () => {
    const entries = ['{"a":1}', '{"b":2}'];
    const leaves = entries.map((s) => createHash('sha256').update(s, 'utf8').digest());
    expect(merkleRootFromCanonicalEntries(entries)).toBe(merkleRoot(leaves));
  });

  it('stable across 100-leaf input — useful sanity for bundle scale', () => {
    const entries: string[] = [];
    for (let i = 0; i < 100; i++) entries.push(`{"i":${i}}`);
    const root = merkleRootFromCanonicalEntries(entries);
    // Re-run; must be byte-identical.
    expect(merkleRootFromCanonicalEntries(entries)).toBe(root);
  });
});
