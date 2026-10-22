import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/env.js';
import { GatewayError, registerErrorHandlers } from './plugins/errors.js';
import { proxyPlugin } from './plugins/proxy.js';
import { registerHealthRoute } from './routes/health.js';

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

function trustProxyOption(value: Config['TRUST_PROXY']) {
  // Fastify's types do not list a hop count, so express it as a predicate.
  return typeof value === 'number' ? (_address: string, hop: number) => hop < value : value;
}

/** Builds the gateway without listening, so tests can use `app.inject()`. */
export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: trustProxyOption(config.TRUST_PROXY),
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  registerErrorHandlers(app, config);

  // In-memory store: correct for a single instance only (see README).
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_request, context) =>
      new GatewayError(context.statusCode, 'RATE_LIMITED', `Rate limit exceeded, retry in ${context.after}`),
  });

  registerHealthRoute(app);

  // Authentication boundary: a JWT-verification onRequest hook (issuer/JWKS
  // from the Identity Service) belongs here, scoped to the proxied routes.
  // Until then, proxied routes are NOT authenticated by the gateway; bearer
  // tokens are forwarded unchanged for downstream services to verify.
  await app.register(proxyPlugin, config);

  return app;
}
