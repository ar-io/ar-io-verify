import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { nanoid } from 'nanoid';

/**
 * Request correlation id. If the upstream (api-guard) injected `x-request-id`
 * (it does, per their proxy contract), thread it through; otherwise synthesize
 * one so logs and metrics always have a stable id per request.
 *
 * The id is echoed back as `X-Request-Id` on the response so clients can
 * correlate. It's also surfaced via `getRequestId(req)` so handlers and the
 * access log can include it in structured log lines.
 */
const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_SLOT: unique symbol = Symbol.for('ar-io-verify.requestId');

interface RequestIdSlot {
  [REQUEST_ID_SLOT]?: string;
}

// Accept anything reasonably URL-safe and bounded — opaque to us, but we
// don't want to echo arbitrary header content back unfiltered.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : nanoid(16);
    (req as Request & RequestIdSlot)[REQUEST_ID_SLOT] = id;
    res.setHeader('x-request-id', id);
    next();
  };
}

export function getRequestId(req: Request): string | null {
  return (req as Request & RequestIdSlot)[REQUEST_ID_SLOT] ?? null;
}
