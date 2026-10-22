import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';

function configError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults and allows downstream URLs to be unset', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      RATE_LIMIT_MAX: 100,
      RATE_LIMIT_WINDOW_MS: 60_000,
      UPSTREAM_CONNECT_TIMEOUT_MS: 2_000,
      UPSTREAM_TIMEOUT_MS: 10_000,
    });
    expect(config.IDENTITY_SERVICE_URL).toBeUndefined();
    expect(config.SERVICE_CATALOG_URL).toBeUndefined();
    expect(config.REQUEST_SERVICE_URL).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ PORT: '', REQUEST_SERVICE_URL: '  ' });
    expect(config.PORT).toBe(3000);
    expect(config.REQUEST_SERVICE_URL).toBeUndefined();
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      PORT: '8080',
      REQUEST_SERVICE_URL: 'http://request-service:8080',
      RATE_LIMIT_MAX: '5',
    });
    expect(config.PORT).toBe(8080);
    expect(config.REQUEST_SERVICE_URL).toBe('http://request-service:8080');
    expect(config.RATE_LIMIT_MAX).toBe(5);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['2', 2],
    ['10.0.0.0/8, 127.0.0.1', ['10.0.0.0/8', '127.0.0.1']],
  ])('parses TRUST_PROXY=%s', (value, expected) => {
    expect(loadConfig({ TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
  });

  it('reports every invalid variable', () => {
    const err = configError({
      PORT: '70000',
      LOG_LEVEL: 'loud',
      REQUEST_SERVICE_URL: 'not-a-url',
      SERVICE_CATALOG_URL: 'ftp://catalog',
      RATE_LIMIT_MAX: '0',
      TRUST_PROXY: 'everyone',
    });
    const variables = err.issues.map((issue) => issue.split(':')[0]);
    expect(variables).toEqual(
      expect.arrayContaining(['PORT', 'LOG_LEVEL', 'REQUEST_SERVICE_URL', 'SERVICE_CATALOG_URL', 'RATE_LIMIT_MAX', 'TRUST_PROXY']),
    );
    expect(err.message).toContain('Invalid environment configuration');
  });

  it('rejects malformed CIDRs in TRUST_PROXY', () => {
    expect(() => loadConfig({ TRUST_PROXY: '10.0.0.0/33' })).toThrow(ConfigError);
  });
});
