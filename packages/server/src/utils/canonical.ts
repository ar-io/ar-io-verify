/**
 * JSON Canonicalization Scheme (JCS) per RFC 8785.
 *
 * Produces a deterministic byte sequence for any JSON value so that
 * SHA-256 + signatures are reproducible across implementations and
 * languages. This is the industry standard form expected by C2PA,
 * VC 2.0 Data Integrity proofs, and most modern audit tooling.
 *
 * Rules (RFC 8785 §3):
 *   - Object keys are sorted by their UTF-16 code unit sequence.
 *   - Strings use the I-JSON subset escaping (RFC 8259 §7).
 *   - Numbers use ECMAScript-compatible serialization (§3.2.2.3) —
 *     for the integer and finite double range we need here this matches
 *     `JSON.stringify` output, but we still reject Infinity/NaN explicitly.
 *   - Arrays preserve element order (array order is semantic).
 *   - No insignificant whitespace, no trailing commas.
 *
 * IMPORTANT: keep this dependency-free. The reference verifier CLI must
 * be able to import it byte-for-byte without pulling in the wider server.
 */

export function canonicalize(value: unknown): string {
  return canonicalizeValue(value);
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new TypeError('JCS: undefined is not representable in JSON');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalizeNumber(value);
  if (typeof value === 'bigint') {
    throw new TypeError('JCS: bigint is not representable; convert to string or number first');
  }
  if (typeof value === 'string') return canonicalizeString(value);
  if (Array.isArray(value)) return canonicalizeArray(value);
  if (typeof value === 'object') return canonicalizeObject(value as Record<string, unknown>);
  throw new TypeError(`JCS: unsupported value type ${typeof value}`);
}

function canonicalizeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`JCS: non-finite number ${n} is not representable`);
  }
  // RFC 8785 §3.2.2.3 mandates ECMAScript ToString for numbers, which is what
  // JSON.stringify uses (-0 serializes as "0", integers as "N", doubles in
  // shortest-roundtrip form). Node's JSON.stringify already conforms.
  return JSON.stringify(n);
}

function canonicalizeString(s: string): string {
  // RFC 8785 §3.2.2.2: I-JSON escaping (RFC 8259 §7). Same as JSON.stringify
  // for any string in Node — JSON.stringify uses the minimum-escape form per
  // §7. Surrogate pairs are preserved as-is (which is what we want for
  // UTF-16-code-unit-ordered key sorting downstream).
  return JSON.stringify(s);
}

function canonicalizeArray(arr: unknown[]): string {
  const parts: string[] = [];
  for (const item of arr) parts.push(canonicalizeValue(item));
  return '[' + parts.join(',') + ']';
}

function canonicalizeObject(obj: Record<string, unknown>): string {
  // RFC 8785 §3.2.3: sort keys by UTF-16 code unit order. String#localeCompare
  // is locale-aware and wrong; default `<` operator on JS strings IS UTF-16
  // code unit comparison, which is exactly what JCS specifies.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    // RFC 8785 §3.2.3: members whose value is undefined are dropped, matching
    // JSON.stringify behavior. Keeps round-tripping with the JS ecosystem.
    if (v === undefined) continue;
    parts.push(canonicalizeString(key) + ':' + canonicalizeValue(v));
  }
  return '{' + parts.join(',') + '}';
}
