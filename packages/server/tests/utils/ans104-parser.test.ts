import { describe, it, expect } from 'vitest';
import { parseDataItemHeader } from '../../src/utils/ans104-parser.js';

/**
 * Build a minimal ANS-104 data item header for testing.
 * Signature type 1 (RSA): 512-byte sig, 512-byte owner.
 */
function buildTestHeader(opts: {
  hasTarget?: boolean;
  hasAnchor?: boolean;
  tagCount?: number;
  tagBytes?: Buffer;
} = {}): Buffer {
  const parts: Buffer[] = [];

  // Signature type: 1 (2 bytes LE)
  const sigType = Buffer.alloc(2);
  sigType.writeUInt16LE(1);
  parts.push(sigType);

  // Signature: 512 bytes
  parts.push(Buffer.alloc(512, 0xaa));

  // Owner: 512 bytes
  parts.push(Buffer.alloc(512, 0xbb));

  // Target
  if (opts.hasTarget) {
    parts.push(Buffer.from([1])); // present
    parts.push(Buffer.alloc(32, 0xcc)); // 32 bytes
  } else {
    parts.push(Buffer.from([0])); // not present
  }

  // Anchor
  if (opts.hasAnchor) {
    parts.push(Buffer.from([1]));
    parts.push(Buffer.alloc(32, 0xdd));
  } else {
    parts.push(Buffer.from([0]));
  }

  // Tag count (8 bytes LE)
  const tagCount = Buffer.alloc(8);
  tagCount.writeBigUInt64LE(BigInt(opts.tagCount ?? 0));
  parts.push(tagCount);

  // Tag bytes length (8 bytes LE)
  const tagBytesLen = Buffer.alloc(8);
  const tb = opts.tagBytes ?? Buffer.alloc(0);
  tagBytesLen.writeBigUInt64LE(BigInt(tb.byteLength));
  parts.push(tagBytesLen);

  // Tag bytes
  if (tb.byteLength > 0) {
    parts.push(tb);
  }

  return Buffer.concat(parts);
}

describe('parseDataItemHeader', () => {
  it('parses a minimal header (no target, no anchor, no tags)', () => {
    const buf = buildTestHeader();
    const result = parseDataItemHeader(buf);

    expect(result).not.toBeNull();
    expect(result!.signatureType).toBe(1);
    expect(result!.signature.byteLength).toBe(512);
    expect(result!.owner.byteLength).toBe(512);
    expect(result!.target.byteLength).toBe(0);
    expect(result!.anchor.byteLength).toBe(0);
    expect(result!.tagCount).toBe(0);
    expect(result!.rawTagBytes.byteLength).toBe(0);
  });

  it('parses header with target and anchor', () => {
    const buf = buildTestHeader({ hasTarget: true, hasAnchor: true });
    const result = parseDataItemHeader(buf);

    expect(result).not.toBeNull();
    expect(result!.target.byteLength).toBe(32);
    expect(result!.anchor.byteLength).toBe(32);
    expect(result!.target[0]).toBe(0xcc);
    expect(result!.anchor[0]).toBe(0xdd);
  });

  it('parses header with tags', () => {
    const tagBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const buf = buildTestHeader({ tagCount: 2, tagBytes });
    const result = parseDataItemHeader(buf);

    expect(result).not.toBeNull();
    expect(result!.tagCount).toBe(2);
    expect(result!.rawTagBytes.byteLength).toBe(5);
    expect(result!.rawTagBytes[0]).toBe(0x01);
  });

  it('returns null for truncated buffer', () => {
    const result = parseDataItemHeader(Buffer.alloc(10));
    expect(result).toBeNull();
  });

  it('returns null for unsupported signature type', () => {
    const buf = buildTestHeader();
    // Overwrite sig type to 99
    buf.writeUInt16LE(99, 0);
    const result = parseDataItemHeader(buf);
    expect(result).toBeNull();
  });
});
