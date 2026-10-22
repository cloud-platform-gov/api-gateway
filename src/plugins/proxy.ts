import httpProxy from '@fastify/http-proxy';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/env.js';
import { GatewayError, sendError } from './errors.js';

export const API_PREFIX = '/api/v1';

interface UpstreamRoute {
  name: string;
  /** Public prefix, under API_PREFIX. */
  prefix: string;
  /** Path the request is forwarded to on the upstream (API_PREFIX is stripped). */
  upstreamPath: string;
  url: string | undefined;
}

export function upstreamRoutes(config: Config): UpstreamRoute[] {
  return [
    { name: 'identity', prefix: `${API_PREFIX}/identity`, upstreamPath: '/identity', url: config.IDENTITY_SERVICE_URL },
    { name: 'service-catalog', prefix: `${API_PREFIX}/services`, upstreamPath: '/services', url: config.SERVICE_CATALOG_URL },
    { name: 'request', prefix: `${API_PREFIX}/requests`, upstreamPath: '/requests', url: config.REQUEST_SERVICE_URL },
  ];
}

/**
 * Forwards `/api/v1/<resource>/...` to `<SERVICE_URL>/<resource>/...`.
 * Method, query string, body and headers (including Authorization) are passed
 * through; client-supplied forwarding headers are replaced with values the
 * gateway computes itself. Requests are never retried.
 */
export async function proxyPlugin(app: FastifyInstance, config: Config): Promise<void> {
  for (const route of upstreamRoutes(config)) {
    if (!route.url) {
      app.log.warn({ service: route.name }, 'upstream URL not configured; requests will return 503');
      const notConfigured = new GatewayError(503, 'SERVICE_NOT_CONFIGURED', `The ${route.name} service is not available`);
      for (const url of [route.prefix, `${route.prefix}/*`]) {
        app.all(url, (_request, reply) => {
          sendError(reply, notConfigured);
        });
      }
      continue;
    }

    const upstream = new URL(route.url);
    const basePath = upstream.pathname.replace(/\/+$/, '');

    await app.register(httpProxy, {
      upstream: upstream.origin,
      prefix: route.prefix,
      rewritePrefix: `${basePath}${route.upstreamPath}`,
      undici: {
        connectTimeout: config.UPSTREAM_CONNECT_TIMEOUT_MS,
        headersTimeout: config.UPSTREAM_TIMEOUT_MS,
        bodyTimeout: config.UPSTREAM_TIMEOUT_MS,
      },
      replyOptions: {
        // reply-from retries GETs that receive a 503 by default; disable all retries.
        retryDelay: () => null,
        rewriteRequestHeaders: (request, headers) => {
          const forwarded = { ...headers };
          for (const header of Object.keys(forwarded)) {
            if (header.startsWith('x-forwarded-') || header === 'forwarded' || header === 'x-real-ip') {
              delete forwarded[header];
            }
          }
          forwarded['x-forwarded-for'] = request.ip;
          forwarded['x-forwarded-proto'] = request.protocol;
          forwarded['x-forwarded-host'] = request.host;
          forwarded['x-request-id'] = request.id;
          return forwarded;
        },
        onError: (reply, { error }) => {
          const timedOut = (error as { statusCode?: number }).statusCode === 504;
          reply.request.log.warn({ err: error, service: route.name }, 'upstream request failed');
          sendError(
            reply,
            timedOut
              ? new GatewayError(504, 'UPSTREAM_TIMEOUT', `The ${route.name} service did not respond in time`)
              : new GatewayError(502, 'BAD_GATEWAY', `The ${route.name} service is unavailable`),
          );
        },
      },
    });
  }
}
