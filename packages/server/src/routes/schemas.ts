import { Router, type Router as RouterType } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Serve the bundle JSON Schema referenced by `$schema` inside every signed
 * bundle. A verifier that wants to validate structurally before checking the
 * signature can fetch this URL and run JSON Schema 2020-12 conformance.
 *
 * Resolved at startup once; missing file is non-fatal (the route 404s) so
 * the server starts even in dev builds where the schema isn't co-located.
 */
function loadSchema(filename: string): string | null {
  const candidates = [
    // dist/ → ../schemas/v2/...
    join(__dirname, '..', 'schemas', 'v2', filename),
    // src/ → ../../schemas/v2/...
    join(__dirname, '..', '..', 'schemas', 'v2', filename),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      // next
    }
  }
  return null;
}

const bundleSchema = loadSchema('bundle.json');
if (!bundleSchema) {
  logger.warn(
    'bundle.json schema file not found — /schemas/v2/bundle.json will return 404. ' +
      'This is expected in some test builds; production should ship the file.'
  );
}

const router: RouterType = Router();

router.get('/v2/bundle.json', (_req, res) => {
  if (!bundleSchema) {
    res.status(404).json({ error: 'schema_not_found' });
    return;
  }
  res.setHeader('Content-Type', 'application/schema+json');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.send(bundleSchema);
});

export default router;
