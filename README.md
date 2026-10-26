# Payment Service

A Node.js microservice that accepts a payment, persists it as `PENDING`, and reaches a terminal status on a background worker. The HTTP API is the edge. The payment aggregate, state machine, and repository port do not depend on Express.

Amounts are integer minor units (kobo or cents). The API accepts a payment-method token and stores only `type` and `last4`.

## Architecture

```mermaid
flowchart LR
  Client --> Routes --> Controllers --> PaymentService
  PaymentService --> Repo[(PaymentRepository)]
  PaymentService --> Queue[JobQueue]
  Queue --> Processor[PaymentProcessor]
  Processor --> Repo
  Processor --> Gateway[PaymentGateway]
  Repo --> Json[JSON file]
  Repo --> Pg[PostgreSQL]
  Repo --> Mem[Memory]
```

`src/composition/create-container.ts` is the only composition root. Tests replace the repository, gateway, clock, and random source without a DI framework.

| Layer                   | Responsibility                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| `routes`, `controllers` | HTTP, status codes, schema validation                              |
| `services`              | Create, idempotency, client transitions, claim, retry, shutdown    |
| `repositories`          | Persistence port                                                   |
| `adapters`              | JSON file, PostgreSQL, memory, simulated gateway, in-process queue |
| `domain`                | Payment aggregate and state machine                                |

## Payment state machine

```mermaid
stateDiagram-v2
  [*] --> PENDING: POST committed
  PENDING --> PROCESSING: worker claims
  PROCESSING --> SUCCEEDED: gateway approval
  PROCESSING --> FAILED: permanent decline or attempts exhausted
  PROCESSING --> PENDING: transient error, attempts remain
  PENDING --> CANCELLED: client PATCH
  SUCCEEDED --> REFUNDED: client PATCH
```

`FAILED`, `CANCELLED`, and `REFUNDED` have no outgoing edge. `SUCCEEDED` can only move to `REFUNDED`.

`PATCH /api/v1/payments/:id/status` accepts `CANCELLED` and `REFUNDED` only. `PROCESSING`, `SUCCEEDED`, and `FAILED` are written by the worker. Cancel is valid from `PENDING`. A payment whose gateway call is in flight (`PROCESSING`) cannot be cancelled. A full refund is applied inside the request transaction. There is no partial refund and no second gateway hop.

While a retry is waiting, the row returns to `PENDING`, so a client can still cancel between attempts.

## Background processing

1. `POST` inserts the payment and the idempotency record in one transaction, then enqueues a job, then returns **202** with the original `PENDING` snapshot.
2. The payment row is the source of truth. If enqueue fails, the response is still 202 and the reconciler picks the row up.
3. A worker claims `PENDING` by moving it to `PROCESSING`, incrementing `attempts` and `version`, and setting `processingStartedAt`. The gateway call happens outside the transaction.
4. A transient failure (`GATEWAY_TIMEOUT`, `GATEWAY_UNAVAILABLE`, or an unknown gateway error) releases the row to `PENDING` and schedules a delay when attempts remain. A permanent `PAYMENT_DECLINED` fails immediately.
5. Equal jitter: `exp = min(cap, base * 2^(attempt-1))`, delay is in `[exp/2, exp]`.
6. A job for a payment that is not `PENDING` or a stale `PROCESSING` row is a no-op.
7. On startup, and on a timer, every `PENDING` payment and every `PROCESSING` payment whose lease has expired is enqueued. Reclaiming a lease does not increment `attempts`. The simulated gateway is a pure function of `(seed, paymentId, attempt)`, so a replayed attempt returns the same decision.
8. The in-process queue caps concurrency (default 5). The delay lives in memory. A crash during backoff loses the timer and the next boot retries immediately.
9. Shutdown stops new HTTP work, pauses the queue, waits up to `SHUTDOWN_DRAIN_MS` for in-flight gateway calls, flushes storage, and exits 0. A charge that is still running stays `PROCESSING` for the next process.

A multi-instance deployment would replace `InProcessJobQueue` with BullMQ (or another durable queue) behind the same `JobQueue` port. Redis is not included.

## Setup

Requires Node.js 20.

```bash
cp .env.example .env
mkdir -p data
npm install
npm run dev
```

The dev server listens on `http://127.0.0.1:4317`. Open `/` for the payment desk. Interactive docs are at `/docs`. The OpenAPI document is at `/openapi.json`. Paste the API key secret into the desk. The page does not include one.

JSON mode needs the parent directory of `JSON_STORE_PATH` to exist. A missing file is created empty. A file that is not valid JSON, or that fails the store schema, aborts startup and is left unchanged.

### Docker

PostgreSQL mode:

```bash
docker compose up --build
```

The API is published on `127.0.0.1:4317` and Postgres on `127.0.0.1:54329`. Compose uses the local demo API key `demo:dev-api-key-change-me`. Replace that key before exposing the port beyond your machine.

### Scripts

| Script                         | Purpose                         |
| ------------------------------ | ------------------------------- |
| `npm run dev`                  | Reload the server with `tsx`    |
| `npm run build` && `npm start` | Compile and run `dist/index.js` |
| `npm test`                     | Jest with the coverage gate     |
| `npm run lint`                 | ESLint                          |
| `npm run format:check`         | Prettier                        |
| `npm run typecheck`            | `tsc --noEmit`                  |
| `npm run openapi:export`       | Write `openapi.json`            |

## Environment

| Variable                         | Default                                  | Purpose                                                                            |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`                       | `development`                            | Runtime mode. Problem responses never include stacks                               |
| `HOST`                           | `127.0.0.1`                              | Bind address. Compose sets `0.0.0.0` inside the container                          |
| `PORT`                           | `4317`                                   | Listen port                                                                        |
| `LOG_LEVEL`                      | `info`                                   | Pino level                                                                         |
| `API_KEYS`                       | required                                 | Comma-separated `clientId:secret` pairs. Secrets must be at least 8 characters     |
| `REPOSITORY_DRIVER`              | `json`                                   | `json`, `postgres`, or `memory`                                                    |
| `JSON_STORE_PATH`                | `./data/payments.json`                   | JSON store path                                                                    |
| `DATABASE_URL`                   | unset                                    | Required when the driver is `postgres`                                             |
| `AUTO_MIGRATE`                   | `true`                                   | Apply `db/migrations/001_init.sql` on startup                                      |
| `CORS_ORIGINS`                   | empty                                    | Comma-separated browser origins. Empty allows no browser origin                    |
| `BODY_LIMIT_BYTES`               | `16384`                                  | JSON body limit                                                                    |
| `RATE_LIMIT_WINDOW_MS`           | `60000`                                  | Rate-limit window                                                                  |
| `RATE_LIMIT_MAX`                 | `100`                                    | API requests per window, per authenticated client                                  |
| `AUTH_FAILURE_RATE_LIMIT_MAX`    | `20`                                     | Failed API key attempts per window, per client address                             |
| `GATEWAY_MIN_LATENCY_MS`         | `20`                                     | Simulated latency floor                                                            |
| `GATEWAY_MAX_LATENCY_MS`         | `50`                                     | Simulated latency ceiling                                                          |
| `GATEWAY_TIMEOUT_MS`             | `2000`                                   | Gateway call timeout                                                               |
| `GATEWAY_TRANSIENT_FAILURE_RATE` | `0`                                      | Share of attempts that fail transiently. Sum with the permanent rate must be ≤ 1   |
| `GATEWAY_PERMANENT_FAILURE_RATE` | `0`                                      | Share of attempts that are declined                                                |
| `GATEWAY_SEED`                   | `1`                                      | Seed for gateway decisions and retry jitter                                        |
| `PAYMENT_MAX_ATTEMPTS`           | `3`                                      | Gateway attempts before a transient failure becomes `FAILED`                       |
| `RETRY_BASE_DELAY_MS`            | `50`                                     | Backoff base                                                                       |
| `RETRY_MAX_DELAY_MS`             | `2000`                                   | Backoff cap                                                                        |
| `WORKER_CONCURRENCY`             | `5`                                      | In-process worker slots                                                            |
| `SHUTDOWN_DRAIN_MS`              | `10000`                                  | How long shutdown waits for in-flight jobs                                         |
| `PROCESSING_LEASE_MS`            | `5000`                                   | How long a `PROCESSING` row is owned by a worker. Must exceed `GATEWAY_TIMEOUT_MS` |
| `RECONCILE_INTERVAL_MS`          | `1000`                                   | How often recoverable rows are re-enqueued                                         |
| `PROBLEM_BASE_URI`               | `https://payment-service.local/problems` | Prefix for problem `type` URIs                                                     |

Invalid configuration throws at startup and the process exits before it listens.

## API

Send `X-Api-Key` on `/api/v1/*`. Health, `/docs`, and `/openapi.json` are public. Errors use `application/problem+json` with a stable `code` and the request id. Stacks stay in the server log.

A payment belongs to the client id of the key that created it. `GET`, list, and `PATCH` for another client return `404`. The worker still settles every client's payments.

| Status | `code`                    | When                                                       |
| ------ | ------------------------- | ---------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`        | Schema failure, including a non-UUID id                    |
| 400    | `MISSING_IDEMPOTENCY_KEY` | `POST` without the header                                  |
| 401    | `UNAUTHORIZED`            | Missing or unknown API key                                 |
| 404    | `PAYMENT_NOT_FOUND`       | Unknown UUID, or a payment owned by another client         |
| 404    | `ROUTE_NOT_FOUND`         | Unknown path                                               |
| 409    | `INVALID_TRANSITION`      | Client status is legal and the current state forbids it    |
| 409    | `VERSION_CONFLICT`        | Stale `If-Match` or lost update                            |
| 413    | `PAYLOAD_TOO_LARGE`       | Body over the limit                                        |
| 415    | `UNSUPPORTED_MEDIA_TYPE`  | `POST` or `PATCH` that is not JSON                         |
| 422    | `IDEMPOTENCY_KEY_REUSED`  | Same key, different body                                   |
| 429    | `RATE_LIMITED`            | Over the per-key window                                    |
| 500    | `INTERNAL_ERROR`          | Unexpected failure                                         |
| 503    | `NOT_READY`               | Shutting down, or the readiness probe cannot reach storage |

`401` is required for API-key auth even though the brief's status list did not name it.

Currencies: `NGN`, `USD`, `EUR`, `GBP`. `amount` is an integer from 1 to 9999999999. ₦1,500.00 is `150000`.

### Create

```bash
curl -sS -D - http://127.0.0.1:4317/api/v1/payments \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-api-key-change-me' \
  -H 'idempotency-key: order-1042-attempt-1' \
  -d '{"amount":150000,"currency":"NGN","description":"Order 1042","paymentMethod":{"type":"card","token":"tok_visa_4242"},"metadata":{"orderId":"1042"}}'
```

`202` with `Location: /api/v1/payments/{id}` and `"status": "PENDING"`. The stored method is `{ "type": "card", "last4": "4242" }`. A 13–19 digit token is rejected as a raw card number.

The same key and the same validated body return that original 202 snapshot, even after the worker has finished. `GET` returns the live payment. The same key with a different body returns 422.

`Idempotency-Key` matches `^[A-Za-z0-9._:-]{8,255}$` and is unique per API client id.

### Read, list, and update

```bash
curl -sS http://127.0.0.1:4317/api/v1/payments/$ID \
  -H 'x-api-key: dev-api-key-change-me'

curl -sS 'http://127.0.0.1:4317/api/v1/payments?status=PENDING&limit=20&offset=0' \
  -H 'x-api-key: dev-api-key-change-me'

curl -sS -X PATCH http://127.0.0.1:4317/api/v1/payments/$ID/status \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-api-key-change-me' \
  -H 'if-match: "1"' \
  -d '{"status":"CANCELLED","reason":"customer changed their mind"}'
```

List is included. The repository already scans for recovery, and the route is a thin page over that query. Order is `createdAt` descending, then `id` ascending. `limit` defaults to 20 and caps at 100.

`If-Match` is optional. When present, a stale version is 409 `VERSION_CONFLICT`. When absent, the server still increments `version` and a lost parallel update returns 409.

### Health

```bash
curl -sS http://127.0.0.1:4317/health/live
curl -sS http://127.0.0.1:4317/health/ready
```

Liveness is 200 while the process is up. Readiness pings the store and returns 503 when the ping fails or the process is shutting down.

## Tests

```bash
npm test
```

The gate is 90% lines and branches on `src/domain` and `src/services`. Adapter behavior is covered by the shared repository contract, HTTP tests, and adapter-specific tests, and is outside that numeric gate.

PostgreSQL contract tests run when `DATABASE_URL` is set. They are skipped locally when it is unset. `CI=true` without `DATABASE_URL` fails the suite, so a green GitHub Actions run means the contract hit Postgres.

```bash
docker compose up -d postgres
DATABASE_URL=postgres://payments:payments@localhost:54329/payments npm test
```

Coverage includes the state machine, idempotency, optimistic locking, gateway timeout, transient-then-success, permanent decline, corrupt JSON, parallel creates, parallel cancels, and shutdown during an in-flight charge.

## Security

- API keys are compared by SHA-256 digest with `crypto.timingSafeEqual`. The raw secret is not stored.
- Helmet is applied to `/api` and `/health`. `/docs` is left outside that middleware so Swagger UI can load its assets.
- CORS is an allow-list. An empty list allows no browser origin. Requests without an `Origin` header are server-to-server and are not rejected by CORS.
- JSON bodies are size-limited. `POST` and `PATCH` require `application/json`.
- Unknown fields are stripped before the idempotency hash is computed, so a retry that drops an ignored field still matches. A typo in a field name is therefore ignored rather than rejected.
- Metadata is at most 20 keys, each matching `^[A-Za-z0-9_.-]{1,64}$`, with string, integer, or boolean values. `__proto__`, `constructor`, and `prototype` are rejected.
- Rate limiting is in memory. On `/api`, an address that sends more than `AUTH_FAILURE_RATE_LIMIT_MAX` unverified keys in a window gets 429 for further unverified requests, whichever keys it tries; a valid key from that address still works. Verified clients get `RATE_LIMIT_MAX` requests per window each. Other pages are limited to `RATE_LIMIT_MAX` per address. Health probes are exempt. The key is checked before the body is parsed. Addresses come from the socket; behind a reverse proxy, Express `trust proxy` must be set for them to be the real client. A second instance needs a shared store.
- Pino redacts `x-api-key`, `authorization`, `idempotency-key`, payment-method tokens, and PAN/CVV field names. Unexpected failures are logged with the error and are not copied into the HTTP body.
- `npm audit --audit-level=high` is part of CI.

## Persistence

`PaymentRepository.withTransaction` is the unit of work.

The JSON adapter holds a process-wide mutex, mutates a draft, and on success writes a temp file in the same directory, `fsync`s it, renames it over the store, and `fsync`s the directory. A thrown callback restores the draft and does not write. Optimistic updates compare `version`. The mutex is process-local, so two processes must not share one file.

PostgreSQL uses `BEGIN` / `COMMIT`, `SELECT … FOR UPDATE` inside a transaction, and a primary key on `(api_client_id, idempotency_key)`. A unique violation after a concurrent insert is turned into the same replay-or-422 decision as the pre-check. `001_init.sql` is applied with `CREATE TABLE IF NOT EXISTS` when `AUTO_MIGRATE=true`. That is one idempotent script, not a migration history.

The memory adapter is what unit and HTTP tests use. It implements the same contract, including rollback and version conflicts.

## Assumptions and trade-offs

1. Idempotency replay returns the stored 202 snapshot, not the live payment. Clients read `GET` for the current status. Records are kept for the life of the store. A TTL is deferred.
2. The idempotency hash is SHA-256 of the canonical validated body, including the payment-method token. Unknown fields are stripped first, so they do not change the hash. The key is scoped by API client id.
3. Refunds are synchronous and full. Partial refunds and an async refund state are deferred.
4. Backoff returns the payment to `PENDING`. The delay is not durable across a crash. Recovery retries immediately.
5. Gateway outcomes are `f(seed, paymentId, attempt)`. Reclaiming a crashed attempt reuses the attempt number, so the decision is stable. The raw token is not stored, which means a real gateway could not be retried after a restart without a vault reference. The simulator does not need the token.
6. A missing JSON file is created when its directory exists. A corrupt file aborts startup. The directory itself is not created, so a bad path cannot silently write somewhere new.
7. `If-Match` is optional. The server always uses `version`. Missing `If-Match` is not 428.
8. Only 2-decimal currencies are accepted. The maximum amount stays inside `Number.MAX_SAFE_INTEGER`.
9. Extra public fields: `paymentMethod`, `statusReason`, `processingStartedAt`. API client id and the request hash stay internal.
10. `GET /api/v1/payments` is in scope. Cursor pagination is deferred. The JSON adapter answers the page with a full scan.
11. Jitter uses a seeded mulberry32 so tests and the simulator are repeatable. Production jitter should use `crypto.randomInt`.
12. Shutdown exits 0 after the drain deadline so a supervisor does not crash-loop. Leftover `PROCESSING` rows are recovered on the next boot.
13. The stack resolved to Express 5, Zod 4, and `@asteasolutions/zod-to-openapi` 9, pinned in `package-lock.json`. TypeScript 6 still emits CommonJS. `ignoreDeprecations: "6.0"` keeps `moduleResolution: node` until a module-format change.
14. `BODY_LIMIT_BYTES` is an integer so the schema does not depend on the bytes-library parser.

## What I would do next for production

- Put the queue on BullMQ/Redis so delays and leases survive a crash and more than one instance can run.
- Store a vault token reference instead of discarding the token after validation.
- Expire idempotency keys, and paginate with a cursor.
- Replace the startup SQL script with a real migration tool.
- Move the rate-limit store and the readiness signal to something shared.
- Give `/docs` a content-security policy that allows only the Swagger assets we ship.
- Use `crypto.randomInt` for retry jitter.
- Add partial refunds as their own state, with a gateway idempotency key of `paymentId:attempt`.

## Project layout

```text
src/domain            payment aggregate and state machine
src/services          create, process, retry, shutdown
src/repositories      persistence port
src/adapters          JSON, PostgreSQL, memory, gateway, queue, logs
src/controllers       HTTP mapping
src/routes            Express routers
src/middleware        auth, rate limit, errors, request id
src/composition       composition root
db/migrations         PostgreSQL schema
test/contract         repository contract shared by every adapter
test/unit             domain, services, adapters
test/integration      HTTP flows
```
