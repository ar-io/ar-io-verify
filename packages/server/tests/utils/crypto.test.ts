import { describe, it, expect } from 'vitest';
import {
  ownerToAddress,
  sha256B64Url,
  base64UrlToBuffer,
  bufferToBase64Url,
  deepHash,
  serializeAvroTags,
} from '../../src/utils/crypto.js';

describe('base64url encoding', () => {
  it('roundtrips buffer through base64url', () => {
    const original = Buffer.from('hello world');
    const encoded = bufferToBase64Url(original);
    const decoded = base64UrlToBuffer(encoded);
    expect(decoded.toString()).toBe('hello world');
  });

  it('handles padding correctly', () => {
    // 1 byte → 2 base64 chars + no padding in base64url
    const buf = Buffer.from([0xff]);
    const encoded = bufferToBase64Url(buf);
    expect(encoded).not.toContain('=');
    expect(base64UrlToBuffer(encoded)[0]).toBe(0xff);
  });

  it('handles url-unsafe characters', () => {
    // Bytes that produce + and / in standard base64
    const buf = Buffer.from([0xfb, 0xff, 0xfe]);
    const encoded = bufferToBase64Url(buf);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(Buffer.compare(base64UrlToBuffer(encoded), buf)).toBe(0);
  });
});

describe('sha256B64Url', () => {
  it('computes correct SHA-256 for known input', () => {
    // SHA-256 of empty string is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = sha256B64Url(Buffer.from(''));
    expect(hash).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  it('produces different hashes for different inputs', () => {
    const h1 = sha256B64Url(Buffer.from('hello'));
    const h2 = sha256B64Url(Buffer.from('world'));
    expect(h1).not.toBe(h2);
  });
});

describe('ownerToAddress', () => {
  it('derives address from a known public key', () => {
    // Use a short test key — ownerToAddress does SHA-256(base64url_decode(key))
    const testKey = bufferToBase64Url(Buffer.from('test-public-key-bytes'));
    const address = ownerToAddress(testKey);
    // Should be base64url(SHA-256(raw bytes))
    const expectedHash = sha256B64Url(Buffer.from('test-public-key-bytes'));
    expect(address).toBe(expectedHash);
  });

  it('produces 43-char address', () => {
    const longKey = bufferToBase64Url(Buffer.alloc(512, 0xab));
    const address = ownerToAddress(longKey);
    expect(address.length).toBe(43);
  });
});

describe('deepHash', () => {
  it('hashes a single blob deterministically', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const h1 = deepHash(data);
    const h2 = deepHash(data);
    expect(Buffer.from(h1).toString('hex')).toBe(Buffer.from(h2).toString('hex'));
  });

  it('produces different hashes for different blobs', () => {
    const h1 = deepHash(new Uint8Array([1, 2, 3]));
    const h2 = deepHash(new Uint8Array([4, 5, 6]));
    expect(Buffer.from(h1).toString('hex')).not.toBe(Buffer.from(h2).toString('hex'));
  });

  it('hashes a list of blobs', () => {
    const result = deepHash([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
    // Should be 48 bytes (SHA-384 output)
    expect(result.byteLength).toBe(48);
  });

  it('handles nested lists', () => {
    const result = deepHash([
      new TextEncoder().encode('dataitem'),
      new TextEncoder().encode('1'),
      [new Uint8Array([10]), new Uint8Array([20])],
      new Uint8Array([30]),
    ]);
    expect(result.byteLength).toBe(48);
  });

  it('handles empty blob', () => {
    const result = deepHash(new Uint8Array(0));
    expect(result.byteLength).toBe(48);
  });

  it('handles empty list', () => {
    const result = deepHash([]);
    expect(result.byteLength).toBe(48);
  });
});

describe('serializeAvroTags', () => {
  it('serializes empty tags to zero terminator', () => {
    const result = serializeAvroTags([]);
    // zigzag(0) = [0x00]
    expect(result.byteLength).toBe(1);
    expect(result[0]).toBe(0);
  });

  it('serializes one tag correctly', () => {
    const result = serializeAvroTags([
      { name: base64UrlToBuffer('hello').toString('base64url'), value: base64UrlToBuffer('world').toString('base64url') },
    ]);
    // Should have: count(1) + name_len + name + value_len + value + terminator(0)
    expect(result.byteLength).toBeGreaterThan(1);
    // Last byte should be 0 (array terminator)
    expect(result[result.byteLength - 1]).toBe(0);
  });

  it('serializes multiple tags', () => {
    const tags = [
      { name: bufferToBase64Url(Buffer.from('App-Name')), value: bufferToBase64Url(Buffer.from('ArDrive')) },
      { name: bufferToBase64Url(Buffer.from('Content-Type')), value: bufferToBase64Url(Buffer.from('image/png')) },
    ];
    const result = serializeAvroTags(tags);
    expect(result.byteLength).toBeGreaterThan(10);
  });

  it('is deterministic', () => {
    const tags = [
      { name: bufferToBase64Url(Buffer.from('key')), value: bufferToBase64Url(Buffer.from('val')) },
    ];
    const r1 = serializeAvroTags(tags);
    const r2 = serializeAvroTags(tags);
    expect(Buffer.compare(Buffer.from(r1), Buffer.from(r2))).toBe(0);
  });
});
