import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_MAX_INFLIGHT: 32,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { requestId, getRequestId } = await import('../../src/middleware/request-id.js');

function buildApp(): express.Express {
  const app = express();
  app.use(requestId());
  app.get('/probe', (req, res) => {
    res.json({ idFromHelper: getRequestId(req) });
  });
  return app;
}

describe('request-id middleware', () => {
  it('echoes the upstream X-Request-Id back on the response and exposes it to handlers', async () => {
    const res = await request(buildApp()).get('/probe').set('X-Request-Id', 'req_abc123');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req_abc123');
    expect(res.body.idFromHelper).toBe('req_abc123');
  });

  it('synthesizes a request id when the upstream did not provide one', async () => {
    const res = await request(buildApp()).get('/probe');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(res.body.idFromHelper).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed upstream ids and synthesizes a fresh one', async () => {
    // The middleware permits [A-Za-z0-9._:-]{1,128}. Anything else is treated
    // as missing/garbage and a fresh nanoid is synthesized. We can't use
    // characters Node's HTTP layer rejects (newlines), so we pass an
    // over-length value here — same effect from the middleware's POV.
    const bad = 'a'.repeat(200);
    const res = await request(buildApp()).get('/probe').set('X-Request-Id', bad);
    expect(res.headers['x-request-id']).not.toBe(bad);
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
