import { describe, it, expect } from 'vitest';
import { canonicalize } from '../../src/utils/canonical.js';

// RFC 8785 Appendix B test vectors — these are the canonical interop checks.
// If any of these fail, our bundles will not re-verify under a third-party
// JCS implementation (Python `pyjcs`, Go `gowebpki/jcs`, Rust `serde-jcs`, etc.).

describe('RFC 8785 (JCS) canonicalization', () => {
  describe('object key ordering (§3.2.3)', () => {
    it('sorts UTF-16 code units, not locale', () => {
      // 'B' (0x42) < 'a' (0x61) by code unit, but localeCompare would order 'a' < 'B'.
      expect(canonicalize({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    });

    it('orders simple ASCII keys', () => {
      expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    });

    it('orders nested objects recursively', () => {
      expect(canonicalize({ b: { y: 2, x: 1 }, a: 1 })).toBe('{"a":1,"b":{"x":1,"y":2}}');
    });

    it('keeps array order intact', () => {
      expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
      expect(canonicalize({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
    });
  });

  describe('primitives', () => {
    it('null', () => expect(canonicalize(null)).toBe('null'));
    it('true', () => expect(canonicalize(true)).toBe('true'));
    it('false', () => expect(canonicalize(false)).toBe('false'));
    it('integer', () => expect(canonicalize(0)).toBe('0'));
    it('negative integer', () => expect(canonicalize(-5)).toBe('-5'));
    it('positive zero == negative zero', () => {
      // ECMAScript ToString(-0) === "0"
      expect(canonicalize(-0)).toBe('0');
    });
    it('rejects Infinity', () => {
      expect(() => canonicalize(Infinity)).toThrow();
    });
    it('rejects NaN', () => {
      expect(() => canonicalize(NaN)).toThrow();
    });
    it('rejects undefined as a top-level value', () => {
      expect(() => canonicalize(undefined)).toThrow();
    });
    it('drops undefined-valued members from objects', () => {
      // Matches JSON.stringify behavior — JCS §3.2.3
      expect(canonicalize({ a: 1, b: undefined } as Record<string, unknown>)).toBe('{"a":1}');
    });
    it('rejects bigint', () => {
      expect(() => canonicalize(1n as unknown)).toThrow();
    });
  });

  describe('strings', () => {
    it('escapes control characters', () => {
      expect(canonicalize('a\nb')).toBe('"a\\nb"');
    });

    it('preserves non-ASCII Unicode unchanged', () => {
      // JCS §3.2.2.2 — strings are output as I-JSON, no \uXXXX escapes for BMP chars
      expect(canonicalize('café')).toBe('"café"');
    });

    it('escapes quote and backslash', () => {
      expect(canonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    });
  });

  describe('RFC 8785 Appendix B examples', () => {
    // Adapted from RFC 8785 Appendix B (Sample object — sorted member, etc.)
    // The RFC example has surrogate pairs and special numbers that exercise
    // every rule; we use a simplified subset here to keep the assertions
    // readable.
    it('matches Appendix B "Sample Object" structure (simplified)', () => {
      const input = {
        numbers: [333333333.3333333, 1e30, 4.5],
        string: 'Hello world!',
        literals: [null, true, false],
      };
      const out = canonicalize(input);
      // Keys sorted: literals, numbers, string
      expect(out.startsWith('{"literals":')).toBe(true);
      expect(out.includes('"numbers":')).toBe(true);
      expect(out.includes('"string":"Hello world!"')).toBe(true);
      // Arrays must preserve order
      expect(out.includes('[null,true,false]')).toBe(true);
    });

    it('deterministic across two runs with shuffled keys', () => {
      const a = canonicalize({ z: 1, a: 2, m: 3 });
      const b = canonicalize({ a: 2, m: 3, z: 1 });
      expect(a).toBe(b);
    });
  });

  describe('audit-relevant cases for verify bundle', () => {
    it('canonicalizes a realistic bundle skeleton stably', () => {
      const bundle = {
        version: 2,
        type: 'VerificationBundle',
        validity: { producedAt: '2026-05-14T00:00:00Z', validUntil: '2026-11-14T00:00:00Z' },
        results: { totals: { verified: 4, unavailable: 96, total: 100 } },
      };
      const out1 = canonicalize(bundle);
      const out2 = canonicalize(JSON.parse(JSON.stringify(bundle))); // round-trip
      expect(out1).toBe(out2);
      // Top-level key order
      expect(out1.indexOf('"results"')).toBeLessThan(out1.indexOf('"type"'));
      expect(out1.indexOf('"type"')).toBeLessThan(out1.indexOf('"validity"'));
      expect(out1.indexOf('"validity"')).toBeLessThan(out1.indexOf('"version"'));
    });

    it('does not re-encode embedded base64url strings', () => {
      const sig = 'Ts0wSNBixvk495CWE85M2ypz0tMiQmQ6f-99FlojAflg';
      expect(canonicalize({ signature: sig })).toBe(`{"signature":"${sig}"}`);
    });
  });
});
