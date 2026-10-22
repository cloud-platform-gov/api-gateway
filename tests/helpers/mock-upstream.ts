import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../../src/config/env.js';

export interface EchoResponse {
  service: string;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockUpstream {
  url: string;
  close: () => Promise<void>;
}

/**
 * Local HTTP server that echoes the request it received as JSON.
 * Any path ending in `/hang` never responds (used for timeout tests).
 */
export async function startMockUpstream(service: string): Promise<MockUpstream> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url?.split('?')[0]?.endsWith('/hang')) return;
      const echo: EchoResponse = {
        service,
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': service });
      res.end(JSON.stringify(echo));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Returns a URL on a port that nothing is listening on. */
export async function unusedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...overrides });
}
