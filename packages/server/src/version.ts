import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Compile-in the server version from package.json so it's available
 * everywhere (logs, OpenAPI, bundle issuer block) without re-parsing
 * the package.json on every read.
 *
 * Reads at module-load time. In production (dist/) the package.json is
 * one directory above dist/; in dev (src/) it's two levels above.
 */
function loadVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Try a couple of likely locations so build vs dev both work without
  // bundler tricks.
  const candidates = [
    join(__dirname, '..', 'package.json'), // dist/ → ../package.json
    join(__dirname, '..', '..', 'package.json'), // src/ → ../../package.json
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return '0.0.0';
}

export const SERVER_VERSION = loadVersion();
