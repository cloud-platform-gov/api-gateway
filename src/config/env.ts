import { isIP } from 'node:net';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const positiveInt = z.coerce.number().int().positive();

const upstreamUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' })
  .optional();

/**
 * TRUST_PROXY controls whether X-Forwarded-* headers are believed when
 * resolving the client IP (used for rate limiting and forwarding headers).
 *   false (default)  -> use the socket address, ignore forwarding headers
 *   true             -> trust every hop (only behind a proxy you fully control)
 *   <n>              -> trust the n closest hops
 *   ip,cidr,...      -> trust only these proxy addresses
 */
const trustProxy = z
  .string()
  .default('false')
  .transform((value, ctx): TrustProxy => {
    const raw = value.trim().toLowerCase();
    if (raw === 'false') return false;
    if (raw === 'true') return true;
    if (/^\d+$/.test(raw)) return Number(raw);
    const entries = raw.split(',').map((entry) => entry.trim());
    const valid = entries.every((entry) => {
      const [address = '', bits, ...rest] = entry.split('/');
      const version = isIP(address);
      if (version === 0 || rest.length > 0) return false;
      if (bits === undefined) return true;
      const prefix = Number(bits);
      return /^\d+$/.test(bits) && prefix <= (version === 4 ? 32 : 128);
    });
    if (!valid) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be "true", "false", a hop count, or a comma-separated list of IPs/CIDRs',
      });
      return z.NEVER;
    }
    return entries;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  TRUST_PROXY: trustProxy,

  IDENTITY_SERVICE_URL: upstreamUrl,
  SERVICE_CATALOG_URL: upstreamUrl,
  REQUEST_SERVICE_URL: upstreamUrl,

  RATE_LIMIT_MAX: positiveInt.default(100),
  RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),

  UPSTREAM_CONNECT_TIMEOUT_MS: positiveInt.default(2_000),
  UPSTREAM_TIMEOUT_MS: positiveInt.default(10_000),
});

export type TrustProxy = boolean | number | string[];
export type Config = z.output<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables. Empty strings are treated as unset so that
 * `FOO=` in an env file falls back to the default (or "not configured").
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const input = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
