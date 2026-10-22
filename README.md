# API Gateway

Single HTTP entry point for the **cloud-platform-gov** citizen services platform. It forwards public `/api/v1/*` requests to the internal microservices and applies cross-cutting concerns in one place.

**Responsibilities**
- Reverse-proxy requests to the Identity, Service Catalog and Request services.
- Rate-limit clients.
- Assign or propagate a request ID (`x-request-id`) for log correlation.
- Return consistent, non-leaky error responses (`502`/`503`/`504` when an upstream fails).
- Expose a process health check (`GET /health`).

**Not** handled here: business logic, persistence, messaging. Authentication is planned but not implemented yet (see [Authentication](#authentication)).

## Stack

Node.js 24 LTS · TypeScript (strict) · Fastify 5 · `@fastify/http-proxy` (undici) · `@fastify/rate-limit` · Zod · Vitest · Docker / Docker Compose

## Prerequisites

- Node.js ≥ 24 and npm
- Docker with Compose v2+ (only for container workflows)

## Getting started

```bash
npm install
cp .env.example .env        # optional; `npm run dev` / `npm start` load .env if present
npm run dev                 # tsx watch mode on http://localhost:3000
```

| Command | Purpose |
|---|---|
| `npm run dev` | Run from TypeScript sources with reload |
| `npm run typecheck` | Type-check `src` and `tests` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the Vitest suite once |
| `npx vitest run tests/proxy.test.ts -t "504"` | Run one file / test by name |

## Configuration

All configuration comes from environment variables, validated at startup with Zod. The gateway exits with code 1 and a list of every invalid variable if validation fails. Empty values count as unset.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. In `production`, 5xx error messages are replaced by a generic message. |
| `HOST` | `0.0.0.0` | Listen address (`0.0.0.0` is required inside containers). |
| `PORT` | `3000` | Listen port. |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, or `silent`. Logs are structured JSON (pino). |
| `TRUST_PROXY` | `false` | Which proxies' `X-Forwarded-*` headers to believe: `false`, `true`, a hop count, or comma-separated IPs/CIDRs. |
| `IDENTITY_SERVICE_URL` | _unset_ | Base URL of the Identity Service. |
| `SERVICE_CATALOG_URL` | _unset_ | Base URL of the Service Catalog. |
| `REQUEST_SERVICE_URL` | _unset_ | Base URL of the Request Service. |
| `RATE_LIMIT_MAX` | `100` | Requests allowed per client IP per window. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `2000` | Upstream TCP connect timeout. |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Max wait for upstream response headers, and max idle time while receiving the body. |

Downstream URLs are **optional**:
- The gateway always starts.
- Requests to a service with no URL set get `503 SERVICE_NOT_CONFIGURED`.
- Requests to a service that is configured but unreachable get `502 BAD_GATEWAY`.
- Requests to a service that doesn't answer in time get `504 UPSTREAM_TIMEOUT`.

Never put real credentials in `.env.example`. `.env` files are ignored by git and excluded from the Docker build context.

## Routing

The gateway owns the public version prefix and **strips `/api/v1`** before forwarding. Everything else is preserved:
- the rest of the path
- the query string
- the method
- the body
- headers, including `Authorization`

| Public prefix | Upstream | Example |
|---|---|---|
| `/api/v1/identity/*` | `IDENTITY_SERVICE_URL` | `/api/v1/identity/users/me` → `{IDENTITY}/identity/users/me` |
| `/api/v1/services/*` | `SERVICE_CATALOG_URL` | `/api/v1/services/42?lang=pt` → `{CATALOG}/services/42?lang=pt` |
| `/api/v1/requests/*` | `REQUEST_SERVICE_URL` | `/api/v1/requests/7` → `{REQUESTS}/requests/7` |

So each downstream service should serve its resources under `/identity`, `/services` and `/requests` respectively. If an upstream URL includes a path (e.g. `http://svc:8080/internal`), that path is kept as a base: `{base}/requests/7`.

**Proxy behaviour**

Forwarding headers:
- Client-supplied `Forwarded`, `X-Forwarded-*` and `X-Real-IP` headers are removed.
- The gateway then sets its own `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Request-Id`.

Retries:
- The gateway never retries a request, so non-idempotent requests are never duplicated.
- This includes reply-from's default behaviour of retrying a GET that gets a `503`, which is turned off.

Error responses:
- Upstream errors are logged together with the request ID.
- Clients get only a generic message, never the upstream host, port or error code.

## Error format

Every error the gateway itself produces has this shape:

```json
{ "error": { "code": "BAD_GATEWAY", "message": "The request service is unavailable", "requestId": "4f1c…" } }
```

The codes are:
- `NOT_FOUND`
- `BAD_REQUEST`
- `RATE_LIMITED`
- `SERVICE_NOT_CONFIGURED`
- `BAD_GATEWAY`
- `UPSTREAM_TIMEOUT`
- `INTERNAL_ERROR`

Stack traces are never sent to clients.

Responses that come from an upstream service are passed through unchanged.

Every response carries `x-request-id`. The gateway reuses a client-supplied ID if it is safe (`[A-Za-z0-9_.-]`, at most 128 chars); otherwise it generates a UUID.

## Rate limiting

- Each client IP may make `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS`.
- Requests over the limit get `429` with `retry-after` and `x-ratelimit-*` headers.
- `/health` is exempt.

The client IP is the socket address unless `TRUST_PROXY` is set. Spoofed `X-Forwarded-For` headers therefore can't be used to dodge the limit.

> The limiter keeps its counters **in memory**. That is correct for a single gateway instance. With multiple replicas, each one counts separately, so the effective limit becomes `RATE_LIMIT_MAX × replicas`. A shared store (e.g. Redis/ElastiCache via the plugin's `redis` option), or rate limiting at the edge (AWS WAF), is required then.

## Authentication

**The gateway does not authenticate requests yet.** Proxied routes are reachable without a token, and the gateway makes no claim that they are protected. `Authorization: Bearer …` headers are forwarded unchanged, so downstream services can verify tokens themselves in the meantime.

Planned integration point: an `onRequest` JWT-verification hook in `src/app.ts`.
- **Position:** after rate limiting, before the proxy (marked with a comment there).
- **Scope:** the proxied routes; specific public routes can be exempted.
- **Configuration:** the Identity Service's issuer, audience and JWKS URL.

It will be added once the Identity Service defines its token format. No placeholder or partial auth is enabled.

## Docker

```bash
docker build -t api-gateway:local .
docker run --rm -p 3000:3000 -e REQUEST_SERVICE_URL=http://host.docker.internal:4003 api-gateway:local

# or with Compose
docker compose up --build -d
docker compose ps                  # STATUS shows (healthy) once /health responds
docker compose down
```

The image:
- Uses a multi-stage build on `node:24-slim`, with only production dependencies in the final image.
- Runs as the non-root `node` user.
- Listens on `0.0.0.0:3000`.
- Has a `HEALTHCHECK` that calls `/health`.
- Handles `SIGTERM` gracefully, closing in-flight requests with a 10 s cap.

**Service URLs: host vs. container.** Inside a container, `localhost` is the container itself, not your machine.

| Gateway runs… | Upstream runs… | Use |
|---|---|---|
| on the host (`npm run dev`) | on the host | `http://localhost:4003` |
| in Docker | on the host | `http://host.docker.internal:4003` (Compose default) |
| in Docker Compose | in the same Compose project | `http://<service-name>:<port>`, e.g. `http://request-service:8080` |

Compose reads the upstream URLs from `DOCKER_IDENTITY_SERVICE_URL`, `DOCKER_SERVICE_CATALOG_URL` and `DOCKER_REQUEST_SERVICE_URL`, falling back to the `host.docker.internal` defaults. Because of the separate names, a host-oriented `.env` doesn't leak `localhost` URLs into the container.

## Example requests

```bash
curl -i http://localhost:3000/health
# 200 {"status":"ok","service":"api-gateway","uptimeSeconds":12}

curl -i http://localhost:3000/api/v1/services?category=health
# 503 SERVICE_NOT_CONFIGURED if SERVICE_CATALOG_URL is unset, 502 if it is down

curl -i -X POST http://localhost:3000/api/v1/requests \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"serviceId":"42","description":"Streetlight broken"}'

curl -i http://localhost:3000/does-not-exist
# 404 {"error":{"code":"NOT_FOUND",...}}
```

## Tests

```bash
npm test
```

The tests use Vitest and Fastify's `inject()`. Proxy tests run against throwaway local HTTP servers on random ports, so no network access is needed.

The suite covers:
- health, 404 and production error masking
- config validation
- rate limiting and spoofed `X-Forwarded-For`
- routing for every prefix
- that method, query, body and `Authorization` are preserved
- forwarding-header sanitisation
- `502`, `503` and `504` handling

The timeout test uses a 100 ms timeout against an upstream that never replies; there are no sleeps.

## Local development vs. production

| | Local | Production (planned) |
|---|---|---|
| Runtime | `npm run dev` or Docker Compose | Container image on ECS Fargate |
| TLS | none (plain HTTP) | Terminated at the load balancer |
| Config | `.env` / Compose env | Task definition env + Secrets Manager / SSM |
| Upstreams | `localhost` / `host.docker.internal` | Private service discovery names |
| Rate limiting | in-memory, single instance | Shared store or WAF across replicas |
| Logs | stdout JSON in the terminal | stdout JSON shipped to CloudWatch Logs |

## AWS deployment (future, not implemented)

Nothing AWS-specific exists in this repository. The gateway is a stateless 12-factor container, so it can run unchanged on:

- **Amazon ECS on Fargate:** one service running this image.
  - Health-check against `/health`.
  - Multiple tasks across AZs.
- **Application Load Balancer:** public HTTPS listener in front of the tasks.
  - The target group forwards to port 3000.
  - Set `TRUST_PROXY` to the VPC/ALB subnet CIDRs so client IPs are taken from the ALB's `X-Forwarded-For`.
- **AWS Certificate Manager:** TLS certificate for the ALB listener.
- **Secrets Manager / SSM Parameter Store:** configuration and future secrets (e.g. JWT settings), injected via the ECS task definition `secrets` block.
- **CloudWatch:** stdout logs via the `awslogs` driver, ALB/ECS metrics, and alarms on 5xx rate, latency and unhealthy targets.
- **Reaching downstream services:**
  - ECS Service Connect or AWS Cloud Map private DNS (e.g. `http://request-service.internal:8080`), or internal ALBs.
  - Downstream services stay in private subnets, and only the gateway's ALB is internet-facing.
- **Before running several replicas:** move rate limiting to a shared store or AWS WAF (see above).

## Limitations / next steps

- No authentication or authorization at the gateway yet (see above).
- `/health` is liveness only. There is no readiness or dependency health aggregation.
- The rate limiter is in-memory.
- There is no metrics endpoint yet. Logs are structured, so metrics can come from logs or be added later.
- WebSockets, CORS and response caching are not configured.
