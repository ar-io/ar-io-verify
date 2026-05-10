import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Tenant context. Verify is strictly multi-tenant by an opaque tenant id —
 * we never validate, authenticate, or quota it. Whoever sits in front of
 * verify (an API gateway, reverse proxy, etc.) is responsible for
 * authentication, rate limiting, billing, and injecting this header.
 */
export interface TenantContext {
  tenantId: string;
}

const TENANT_HEADER = 'x-tenant-id';
const DEV_FALLBACK_TENANT = 'tenant_dev_local';

// Conservative envelope for the opaque tenant id. Verify never validates the
// value semantically — but it does end up as a primary-key column and partial
// unique index, so we cap length and charset to keep the index well-behaved
// and reject obvious garbage. 128 chars / [A-Za-z0-9_.:-] covers any sane
// upstream identity scheme (UUIDs, KSUIDs, opaque hex, etc).
const TENANT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

// Symbol-keyed slot on the request — avoids fragile module augmentation
// while still preventing accidental collisions with other middleware.
const TENANT_SLOT: unique symbol = Symbol.for('ar-io-verify.tenant');

interface TenantSlot {
  [TENANT_SLOT]?: TenantContext;
}

/**
 * Extract the tenant id from the X-Tenant-Id header and attach it to the
 * request. In production, missing tenant id is a 401. In non-production,
 * a synthetic tenant is injected so the sidecar can be exercised end-to-end
 * without anything sitting in front of it.
 */
export function requireTenant(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const tenantId = req.header(TENANT_HEADER);

    if (!tenantId) {
      if (process.env.NODE_ENV !== 'production') {
        (req as Request & TenantSlot)[TENANT_SLOT] = { tenantId: DEV_FALLBACK_TENANT };
        return next();
      }
      res.status(401).json({ error: 'Missing X-Tenant-Id header' });
      return;
    }

    if (!TENANT_ID_PATTERN.test(tenantId)) {
      res.status(400).json({ error: 'Invalid X-Tenant-Id format' });
      return;
    }

    (req as Request & TenantSlot)[TENANT_SLOT] = { tenantId };
    next();
  };
}

export function getTenant(req: Request): TenantContext {
  const slot = (req as Request & TenantSlot)[TENANT_SLOT];
  if (!slot) {
    throw new Error('Tenant context not set — requireTenant() middleware missing on this route');
  }
  return slot;
}
