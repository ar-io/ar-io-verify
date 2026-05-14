// RFC 8785 (JCS) canonicalization. Mirror of packages/server/src/utils/canonical.ts —
// kept dependency-free and as a separate copy on purpose, so the reference
// verifier is an honest independent re-implementation (an auditor can diff
// the two files and confirm semantic equivalence) rather than reusing the
// same code we sign with.

export function canonicalize(value) {
  return canonicalizeValue(value);
}

function canonicalizeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) throw new TypeError('JCS: undefined is not representable');
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`JCS: non-finite number ${value} is not representable`);
    return JSON.stringify(value);
  }
  if (t === 'bigint') throw new TypeError('JCS: bigint is not representable');
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalizeValue).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + canonicalizeValue(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`JCS: unsupported value type ${t}`);
}
