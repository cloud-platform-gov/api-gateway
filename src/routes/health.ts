import type { FastifyInstance } from 'fastify';

/**
 * Liveness of the gateway process only. Deliberately does not check
 * downstream services, so an unavailable upstream never marks the gateway unhealthy.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    service: 'api-gateway',
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
