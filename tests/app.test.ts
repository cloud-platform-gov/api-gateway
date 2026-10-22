import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers/mock-upstream.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  it('GET /health returns 200 without any upstream configured', async () => {
    app = await buildApp(testConfig());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'api-gateway' });
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('reuses a safe incoming x-request-id and replaces an unsafe one', async () => {
    app = await buildApp(testConfig());
    const kept = await app.inject({ url: '/health', headers: { 'x-request-id': 'abc-123' } });
    expect(kept.headers['x-request-id']).toBe('abc-123');
    const replaced = await app.inject({ url: '/health', headers: { 'x-request-id': 'bad id\n<script>' } });
    expect(replaced.headers['x-request-id']).not.toBe('bad id\n<script>');
  });
});

describe('error responses', () => {
  it('unknown routes return a consistent 404', async () => {
    app = await buildApp(testConfig());
    const res = await app.inject({ method: 'GET', url: '/nope?x=1', headers: { 'x-request-id': 'req-1' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /nope not found', requestId: 'req-1' },
    });
  });

  it('hides internal error details in production', async () => {
    app = await buildApp(testConfig({ NODE_ENV: 'production' }));
    app.get('/boom', async () => {
      throw new Error('db password=hunter2 at /srv/internal.ts');
    });
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: expect.any(String) },
    });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('stack');
  });

  it('shows the error message (but never the stack) outside production', async () => {
    app = await buildApp(testConfig({ NODE_ENV: 'development' }));
    app.get('/boom', async () => {
      throw new Error('something broke');
    });
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe('something broke');
    expect(res.body).not.toContain('at ');
  });
});

describe('rate limiting', () => {
  it('returns 429 after the configured limit and exempts /health', async () => {
    app = await buildApp(testConfig({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' }));
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await app.inject({ url: '/api/v1/requests' })).statusCode);
    }
    expect(statuses).toEqual([503, 503, 429]);

    const limited = await app.inject({ url: '/api/v1/requests' });
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(limited.headers['retry-after']).toBeDefined();

    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For unless TRUST_PROXY is enabled', async () => {
    app = await buildApp(testConfig({ RATE_LIMIT_MAX: '1' }));
    const first = await app.inject({ url: '/api/v1/requests', headers: { 'x-forwarded-for': '1.1.1.1' } });
    const spoofed = await app.inject({ url: '/api/v1/requests', headers: { 'x-forwarded-for': '2.2.2.2' } });
    expect(first.statusCode).toBe(503);
    expect(spoofed.statusCode).toBe(429);
  });
});
