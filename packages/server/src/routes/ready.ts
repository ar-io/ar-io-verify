import { Router, type Router as RouterType } from 'express';
import { getDb } from '../storage/db.js';
import { checkGatewayHealth } from '../gateway/client.js';
import { isSigningEnabled } from '../utils/signing.js';
import { logger } from '../utils/logger.js';

/**
 * Readiness vs liveness:
 *   - GET /health is the existing liveness probe — the process is up and
 *     can respond. Kubernetes-style livenessProbe should hit /health.
 *   - GET /ready (this) is the readiness probe — the process is up AND
 *     its critical dependencies (DB, gateway) are reachable. Use as
 *     readinessProbe; failing this should drain traffic, not kill the pod.
 *
 * Signing wallet status is informational, not a readiness gate — the server
 * runs intentionally without one (single-tx verification still works, just
 * without operator attestation).
 */
const router: RouterType = Router();

router.get('/', async (_req, res) => {
  const checks: { db: boolean; gateway: boolean; signing: boolean } = {
    db: false,
    gateway: false,
    signing: isSigningEnabled(),
  };

  try {
    getDb().prepare('SELECT 1 AS ok').get();
    checks.db = true;
  } catch (err) {
    logger.warn({ err }, 'readiness check: db failed');
  }

  try {
    checks.gateway = await checkGatewayHealth();
  } catch (err) {
    logger.warn({ err }, 'readiness check: gateway failed');
  }

  const ready = checks.db && checks.gateway;
  res.status(ready ? 200 : 503).json({ ready, checks });
});

export default router;
