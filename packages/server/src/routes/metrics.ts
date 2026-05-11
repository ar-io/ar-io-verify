import { Router, type Router as RouterType } from 'express';
import { registry } from '../utils/metrics.js';

/**
 * Prometheus scrape endpoint. Returns the default Node metrics plus the
 * verify-specific counters/gauges/histograms in `utils/metrics.ts`.
 *
 * Deployment note: this endpoint contains aggregate operational data only
 * (no per-tenant labels — see utils/metrics.ts comments). Still, operators
 * should restrict access at the proxy layer rather than expose it publicly.
 */
const router: RouterType = Router();

router.get('/', async (_req, res) => {
  try {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : 'metrics_error');
  }
});

export default router;
