import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { LOG_LEVEL: 'error', SIGNING_KEY_PATH: '' },
  resolvePublicGatewayUrl: () => 'https://gw.example/',
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { default: schemasRouter } = await import('../../src/routes/schemas.js');

import express from 'express';
import request from 'supertest';

function buildApp(): express.Express {
  const app = express();
  app.use('/schemas', schemasRouter);
  return app;
}

describe('GET /schemas/v2/bundle.json', () => {
  it('serves the bundle JSON Schema with the right content-type', async () => {
    const app = buildApp();
    const res = await request(app).get('/schemas/v2/bundle.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/schema+json');
    const body = JSON.parse(res.text);
    expect(body['$id']).toBe('https://verify.ar.io/schemas/v2/bundle.json');
    expect(body.title).toContain('Verification Bundle V2');
    expect(body.required).toContain('payloadHash');
    expect(body.required).toContain('signature');
  });
});
