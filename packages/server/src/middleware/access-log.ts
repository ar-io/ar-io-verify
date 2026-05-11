import type { RequestHandler } from 'express';
import { logger } from '../utils/logger.js';
import { getRequestId } from './request-id.js';
import { httpRequestDuration, httpRequests } from '../utils/metrics.js';

/**
 * Structured access log + HTTP metrics for every request. Runs after
 * requestId() and tenant() so it can include both. Logs at info on 2xx/3xx,
 * warn on 4xx, error on 5xx. Routes are normalized via req.route.path when
 * available so /jobs/abc and /jobs/xyz collapse to one label.
 */
export function accessLog(): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      const tenantId = (req as { tenant?: { tenantId: string } }).tenant?.tenantId ?? null;
      const fields = {
        requestId: getRequestId(req),
        tenantId,
        method: req.method,
        route,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationSec * 1000),
      };
      if (res.statusCode >= 500) {
        logger.error(fields, 'request');
      } else if (res.statusCode >= 400) {
        logger.warn(fields, 'request');
      } else {
        logger.info(fields, 'request');
      }
      try {
        httpRequests.inc({ route, status_class: statusClass });
        httpRequestDuration.observe({ route }, durationSec);
      } catch {
        // Metric labels with too-high cardinality could throw — never let
        // observability blow up a real request.
      }
    });
    next();
  };
}
