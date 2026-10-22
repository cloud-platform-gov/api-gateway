import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { startMockUpstream, testConfig, unusedPortUrl, type EchoResponse, type MockUpstream } from './helpers/mock-upstream.js';

let identity: MockUpstream;
let catalog: MockUpstream;
let requests: MockUpstream;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  [identity, catalog, requests] = await Promise.all([
    startMockUpstream('identity'),
    startMockUpstream('service-catalog'),
    startMockUpstream('request'),
  ]);
});

afterAll(async () => {
  await Promise.all([identity.close(), catalog.close(), requests.close()]);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function upstreamConfig(overrides: Record<string, string> = {}) {
  return testConfig({
    IDENTITY_SERVICE_URL: identity.url,
    SERVICE_CATALOG_URL: catalog.url,
    REQUEST_SERVICE_URL: requests.url,
    ...overrides,
  });
}

describe('routing', () => {
  it.each([
    ['/api/v1/identity/users/me', 'identity', '/identity/users/me'],
    ['/api/v1/services', 'service-catalog', '/services'],
    ['/api/v1/services/42', 'service-catalog', '/services/42'],
    ['/api/v1/requests/7/attachments', 'request', '/requests/7/attachments'],
  ])('%s -> %s %s', async (publicPath, service, upstreamPath) => {
    app = await buildApp(upstreamConfig());
    const res = await app.inject({ method: 'GET', url: publicPath });
    expect(res.statusCode).toBe(200);
    const echo = res.json<EchoResponse>();
    expect(echo.service).toBe(service);
    expect(echo.url).toBe(upstreamPath);
  });

  it('keeps an upstream base path', async () => {
    app = await buildApp(upstreamConfig({ REQUEST_SERVICE_URL: `${requests.url}/internal/` }));
    const res = await app.inject({ url: '/api/v1/requests/1' });
    expect(res.json<EchoResponse>().url).toBe('/internal/requests/1');
  });

  it('does not match look-alike prefixes', async () => {
    app = await buildApp(upstreamConfig());
    const res = await app.inject({ url: '/api/v1/requestsX' });
    expect(res.statusCode).toBe(404);
  });
});

describe('request forwarding', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'preserves %s, query string, body and Authorization',
    async (method) => {
      app = await buildApp(upstreamConfig());
      const payload = JSON.stringify({ title: 'Pothole', priority: 2 });
      const res = await app.inject({
        method,
        url: '/api/v1/requests/9?status=open&tag=a&tag=b',
        headers: { authorization: 'Bearer abc.def.ghi', 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(200);
      const echo = res.json<EchoResponse>();
      expect(echo.method).toBe(method);
      expect(echo.url).toBe('/requests/9?status=open&tag=a&tag=b');
      expect(echo.body).toBe(payload);
      expect(echo.headers.authorization).toBe('Bearer abc.def.ghi');
      expect(echo.headers['content-type']).toBe('application/json');
    },
  );

  it('passes upstream status and headers back to the client', async () => {
    app = await buildApp(upstreamConfig());
    const res = await app.inject({ url: '/api/v1/services' });
    expect(res.headers['x-upstream']).toBe('service-catalog');
  });

  it('replaces client-supplied forwarding headers and forwards the request id', async () => {
    app = await buildApp(upstreamConfig());
    const res = await app.inject({
      url: '/api/v1/identity/me',
      remoteAddress: '203.0.113.5',
      headers: {
        'x-request-id': 'trace-42',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.example',
        'x-real-ip': '6.6.6.6',
        forwarded: 'for=6.6.6.6',
      },
    });
    const { headers } = res.json<EchoResponse>();
    expect(headers['x-forwarded-for']).toBe('203.0.113.5');
    expect(headers['x-forwarded-host']).not.toBe('evil.example');
    expect(headers['x-real-ip']).toBeUndefined();
    expect(headers.forwarded).toBeUndefined();
    expect(headers['x-request-id']).toBe('trace-42');
  });

  it('uses X-Forwarded-For from a trusted proxy', async () => {
    app = await buildApp(upstreamConfig({ TRUST_PROXY: '127.0.0.1' }));
    const res = await app.inject({
      url: '/api/v1/identity/me',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.json<EchoResponse>().headers['x-forwarded-for']).toBe('198.51.100.7');
  });
});

describe('upstream failures', () => {
  it('returns 502 without leaking the upstream address when the service is down', async () => {
    const deadUrl = await unusedPortUrl();
    app = await buildApp(upstreamConfig({ REQUEST_SERVICE_URL: deadUrl }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/requests' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { code: 'BAD_GATEWAY', message: 'The request service is unavailable', requestId: expect.any(String) },
    });
    const port = new URL(deadUrl).port;
    expect(res.body).not.toContain(port);
    expect(res.body).not.toContain('127.0.0.1');
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('returns 502 for a request with a body when the service is down', async () => {
    // Uses a real socket: inject() surfaces the aborted upload as a rejection
    // instead of delivering the 502 the gateway actually sends.
    app = await buildApp(upstreamConfig({ REQUEST_SERVICE_URL: await unusedPortUrl() }));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${address}/api/v1/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'BAD_GATEWAY' } });
  });

  it('returns 503 when the service URL is not configured', async () => {
    app = await buildApp(testConfig());
    for (const url of ['/api/v1/identity', '/api/v1/services/1', '/api/v1/requests?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: 'SERVICE_NOT_CONFIGURED' } });
    }
  });

  it('returns 504 when the upstream does not respond in time', async () => {
    app = await buildApp(upstreamConfig({ UPSTREAM_TIMEOUT_MS: '100' }));
    const res = await app.inject({ url: '/api/v1/requests/hang' });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: { code: 'UPSTREAM_TIMEOUT' } });
    expect(res.body).not.toContain('127.0.0.1');
  });
});
