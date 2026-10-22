import type { FastifyError, FastifyInstance, FastifyReply, RawServerBase, RouteGenericInterface } from 'fastify';
import type { Config } from '../config/env.js';

/** An error whose code and message are safe to show to clients. */
export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

// Accepts replies from both normal routes and reply-from callbacks (typed over RawServerBase).
type AnyReply = FastifyReply | FastifyReply<RouteGenericInterface, RawServerBase>;

export function sendError(reply: AnyReply, error: GatewayError): void {
  const body: ErrorBody = {
    error: { code: error.code, message: error.message, requestId: reply.request.id },
  };
  reply.code(error.statusCode).type('application/json; charset=utf-8').send(body);
}

/**
 * Single place that turns any thrown error into the public error format.
 * Stack traces are only ever logged; 5xx messages are hidden in production.
 */
export function registerErrorHandlers(app: FastifyInstance, config: Config): void {
  const isProduction = config.NODE_ENV === 'production';

  app.setErrorHandler((err: FastifyError | GatewayError, request, reply) => {
    if (err instanceof GatewayError) {
      sendError(reply, err);
      return;
    }

    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;

    if (statusCode >= 500) {
      request.log.error({ err }, 'unhandled error');
      const message = isProduction ? 'Internal server error' : err.message;
      sendError(reply, new GatewayError(statusCode, 'INTERNAL_ERROR', message));
      return;
    }

    request.log.info({ err }, 'client error');
    const code = CLIENT_ERROR_CODES[statusCode] ?? 'CLIENT_ERROR';
    sendError(reply, new GatewayError(statusCode, code, err.message));
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, new GatewayError(404, 'NOT_FOUND', `Route ${request.method} ${request.url.split('?')[0]} not found`));
  });
}
