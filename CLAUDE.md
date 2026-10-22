# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The API Gateway of `cloud-platform-gov`, a distributed citizen-services platform built for a Cloud Computing course. It is a Fastify 5 + TypeScript (strict, ESM, `nodenext`) reverse proxy and the single public entry point.

It sits in front of these services, which are developed separately and may not exist yet:

| Service | Stack |
|---|---|
| Identity | Node/TS |
| Service Catalog | Go |
| Request | Go |
| Notification | Python (not routed through the gateway yet) |

Planned infrastructure: PostgreSQL, RabbitMQ, S3-compatible storage, and later ECS Fargate on AWS.

Scope rules for this component:
- No business logic, no database, no RabbitMQ.
- No AWS SDKs or IaC (Terraform/Kubernetes). AWS is documented as future deployment only.
- Don't return fake data for missing services. A missing service returns 503; never add mock responses in `src/`.
- Don't add placeholder or partial auth. Any JWT validation must be complete, configurable and tested before it is enabled.
- Keep dependencies minimal. There is no DI container and no extra abstraction layers; plain functions plus Fastify plugins.

The README is the user-facing spec: route contract, error codes, env table, Docker usage, AWS notes. **Update it whenever behaviour changes.**

## Commands

npm is the package manager (pnpm is not installed). Node ≥ 24.

- `npm run dev`: run with tsx watch; loads `.env` if present (`--env-file-if-exists`).
- `npm run typecheck`: `tsc` over `src` + `tests`. `tsconfig.json` has `noEmit`.
- `npm run build`: emits `dist/` via `tsconfig.build.json`.
- `npm start`: runs `dist/server.js`.
- `npm test`: `vitest run`.
  - Single file or test: `npx vitest run tests/proxy.test.ts -t "504"`.
- `docker compose up --build -d`: runs the gateway only, with upstreams at `host.docker.internal:4001-4003`.

Before finishing a change, run `npm run typecheck && npm test`. If you touch the `Dockerfile` or the dependencies, also run `docker build`.

## Request lifecycle

The order is set by registration order in `src/app.ts`; keep it.

1. **`genReqId`**: reuse an inbound `x-request-id` if it matches `^[\w.-]{1,128}$`, otherwise use `randomUUID()`. Fastify's built-in `requestIdHeader` is disabled on purpose.
2. **`onRequest` hook**: echoes `x-request-id` on every response, including errors and 429s.
3. **Rate limit** (`@fastify/rate-limit`): global, in-memory, keyed by `request.ip`.
   - Routes opt out with `config: { rateLimit: false }`, as `/health` does.
   - The 404 handler is not rate-limited.
4. **(Future) JWT hook**: goes here, before the proxy. The spot is marked with a comment in `app.ts`.
5. **Route handler**: either `/health` or a proxy route.
   - The proxy registers `@fastify/http-proxy` once per upstream, each in its own encapsulated context.
   - That plugin adds pass-through content-type parsers, so proxied bodies are streamed raw, never parsed.
6. **Errors**: a thrown error goes to `setErrorHandler`; a proxy failure goes to the `onError` callback in `replyOptions`. Both end in `sendError()`.

`request.ip`, `request.protocol` and `request.host` honour `TRUST_PROXY`. `trustProxyOption()` in `app.ts` converts a numeric hop count into a predicate, because Fastify's types don't accept a number.

## Module map

- **`src/server.ts`**: process entry point; the only file that touches `process.env`, signals and `process.exit`.
- **`src/app.ts`**: `buildApp(config)` returns a not-yet-listening instance.
  - Tests call `app.inject()` on it.
  - Tests can also add routes before the first inject (e.g. a throwing `/boom` route).
- **`src/config/env.ts`**: the Zod schema is the single source of truth for env vars.
  - Empty strings count as unset.
  - Upstream URLs are optional and must be `http`/`https`.
  - `loadConfig(source)` takes any env-like object.
  - It throws a `ConfigError` with one `"VAR: message"` entry per issue.
- **`src/plugins/errors.ts`**:
  - `GatewayError(statusCode, code, message)` is the only client-safe error type.
  - `sendError()` is the only function that writes error bodies.
  - The error handler maps other errors:
    - Below 500: a code from `CLIENT_ERROR_CODES`, with the original message.
    - 500 and above: `INTERNAL_ERROR`, with a generic message when `NODE_ENV=production`.
  - `AnyReply` exists because reply-from callbacks are typed over `RawServerBase`.
- **`src/plugins/proxy.ts`**: the `upstreamRoutes()` table plus the proxy options:
  - `rewritePrefix` = upstream base path + `upstreamPath`. Only `/api/v1` is stripped.
  - `undici: { connectTimeout, headersTimeout, bodyTimeout }`.
  - `retryDelay: () => null`. **Must stay.** Without it, reply-from retries a GET that gets a 503 up to 10 times.
  - `rewriteRequestHeaders`: strips client `x-forwarded-*`, `forwarded` and `x-real-ip`, then sets the gateway's own values plus `x-request-id`.
  - `onError`: an error with `statusCode === 504` (headers timeout or connect timeout) becomes `UPSTREAM_TIMEOUT`; everything else becomes 502 `BAD_GATEWAY`. Log the cause, but never put the upstream host or port or the error code in the response.

## Conventions

Code style:
- 2-space indent, single quotes, semicolons, trailing commas.
- Relative imports end in `.js` (nodenext ESM).
- Type-only imports use `import type` (`verbatimModuleSyntax` is on).
- `noUncheckedIndexedAccess` is on, so indexed reads may be `undefined`.

Error codes are `UPPER_SNAKE_CASE` and part of the public contract; the README lists them. Don't rename them casually.

Error messages may name a service ("The request service is unavailable") but never internal addresses.

Comments are sparse and explain *why* (security or behaviour decisions), not what.

## Common changes

**Add an upstream service**

1. Add `<NAME>_SERVICE_URL: upstreamUrl` to the schema in `env.ts`.
2. Add a row to `upstreamRoutes()` in `proxy.ts`: `name`, `prefix` (under `API_PREFIX`) and `upstreamPath`.
3. Update `.env.example` and `docker-compose.yml`. Compose uses a `DOCKER_<NAME>_SERVICE_URL` override, defaulting to `host.docker.internal`.
4. Update the README tables (env and routing).
5. Add the path to the routing `it.each` in `tests/proxy.test.ts`, with a new mock in `beforeAll`.

**Add an env var**

Update all four places:
- the schema
- `.env.example`
- the README env table
- `docker-compose.yml`, if the var is relevant in containers

Add a config test if it has non-trivial parsing.

**Add a gateway-owned route**

Register it in `app.ts` before the proxy, as a function like `registerHealthRoute`. Decide explicitly whether it is rate-limited.

## Testing notes

- **Mock upstreams:** `tests/helpers/mock-upstream.ts` provides:
  - `startMockUpstream(name)`: an echo server on port 0 that returns `{service, method, url, headers, body}`. Any path ending in `/hang` never responds; this drives the timeout tests with `UPSTREAM_TIMEOUT_MS=100`.
  - `unusedPortUrl()`: a URL on a closed port, for 502 tests.
  - `testConfig(overrides)`: builds a config with `NODE_ENV=test` and `LOG_LEVEL=silent`.
- **No sleeps:** tests must not depend on sleeps or external network access.
- **Gotcha:** when an upstream connection fails for a request *with a body*, `inject()` (light-my-request) rejects with the upstream error instead of returning the 502 that real clients get. Test those cases over a real socket (`app.listen({ port: 0 })` + `fetch`), as `proxy.test.ts` does.
- **Cleanup:** close every app in `afterEach`. Tests that `listen` must also be closed there.

## Docker / environments

- `HOST` must be `0.0.0.0` in containers; the image sets it, along with `NODE_ENV=production` and `PORT=3000`.
- `.env*` files are excluded by `.dockerignore`. Don't copy them into the image; configuration comes only from the runtime environment.
- **Upstream URLs depend on where the gateway runs:**
  - On the host: `localhost`.
  - In a container calling services on the host: `host.docker.internal`.
  - Inside a Compose network: `<service-name>:<port>`.
- The `HEALTHCHECK` uses Node's built-in `fetch`, because `node:24-slim` has no curl.
