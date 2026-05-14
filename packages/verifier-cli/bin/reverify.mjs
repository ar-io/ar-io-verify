#!/usr/bin/env node
// Reference offline verifier for ar.io Verify VerificationBundle V2.
// Usage:  reverify <path-to-bundle.json>
// Exit codes: 0 = PASS (all steps ok), 1 = FAIL (any step failed), 2 = bad input.

import { readFileSync } from 'node:fs';
import { reverifyBundle } from '../src/reverify.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  process.stderr.write(
    'Usage: reverify <bundle.json>\n' +
      '\n' +
      '  Reads a VerificationBundle V2 JSON file, recomputes its payload hash,\n' +
      '  reconstructs the per-tx Merkle root, and verifies the RSA-PSS-SHA256\n' +
      '  signature against the bundle.issuer.operatorPublicKey.\n' +
      '\n' +
      '  Needs nothing from the verify server — the whole point of an offline\n' +
      '  verifiable bundle.\n'
  );
  process.exit(args.length === 0 ? 2 : 0);
}

const path = args[0];
let bundle;
try {
  bundle = JSON.parse(readFileSync(path, 'utf-8'));
} catch (err) {
  process.stderr.write(`error: could not read or parse ${path}: ${err.message}\n`);
  process.exit(2);
}

const report = reverifyBundle(bundle);

process.stdout.write(`Bundle: ${path}\n`);
if (bundle.id) process.stdout.write(`Id:     ${bundle.id}\n`);
if (bundle.issuer?.operator) process.stdout.write(`Issuer: ${bundle.issuer.operator}\n`);
process.stdout.write(`Result: ${report.ok ? 'PASS' : 'FAIL'}\n\n`);
for (const step of report.steps) {
  const tag = step.ok ? '[OK]  ' : '[FAIL]';
  process.stdout.write(`${tag} ${step.name}\n        ${step.detail}\n`);
}

process.exit(report.ok ? 0 : 1);
