# Module: health

Valid for main at 48aa967 (2026-11-18).

The `health` module answers the API process's liveness and readiness probes. It is the smallest module in `src/modules/`: one router file, no service, no policy and no repository. Read this page if you operate the API containers, wire a new dependency into readiness, or wonder why the worker has its own, separate probe.

## 1. Purpose and bounded context

| Question | Answer |
| --- | --- |
| What does the module own? | Two unauthenticated routes, `GET /health/live` and `GET /health/ready`, on the API process (`src/modules/health/health.router.ts:14`, `src/modules/health/health.router.ts:18`). |
| What does it not own? | The worker's probe (`/health/live`, `/health/ready` and `/metrics` on `127.0.0.1:3001`) lives in `src/shared/health/worker-heartbeat.ts`, outside this module (`src/shared/health/worker-heartbeat.ts:4`, `src/shared/health/worker-heartbeat.ts:34-57`). See [../jobs-and-workers.md](../jobs-and-workers.md). |
| Does it touch the database schema? | No table. Readiness runs one `SELECT 1` (`src/infrastructure/database/database-probe.ts`, `PrismaDatabaseProbe.check`). |
| Who calls it? | The Docker health check of the API container (`docker-compose.yml:137`, `docker-compose.staging.yml:264`), load balancers and operators. |

## 2. File map

The module is flat; it has no `api`, `application`, `domain` or `repository` directory.

| Layer | File | Lines | Responsibility |
| --- | --- | --- | --- |
| api | `src/modules/health/health.router.ts` | 35 | `createHealthRouter(databaseProbe)` builds the router. `healthResponseSchema` (`z.object({ status: z.literal("ok") })`, `src/modules/health/health.router.ts:7-9`) is the only response shape. |
| infrastructure (outside the module) | `src/infrastructure/database/database-probe.ts` | 13 | Interface `DatabaseProbe { check(): Promise<void> }` and `PrismaDatabaseProbe`, whose `check` runs ``$queryRaw`SELECT 1` ``. |
| composition | `src/server.ts:579` | | Builds `new PrismaDatabaseProbe(database)` and hands it to `createApp` as `databaseProbe`. |
| composition | `src/app.ts:590` | | `app.use("/health", createHealthRouter(dependencies.databaseProbe))`. |

`src/app.ts:590` comes after `requestContext`, `pino-http`, `cors`, `helmet`, the `/.well-known` routes, the Better Auth handler at `/api/auth/*splat`, the Coinbase onramp webhook and the JSON body parser (`src/app.ts:504-588`) and before the `/v1/offerings` router and the protected routers (`src/app.ts:591-596`). No rate limiter is attached to `/health`; the limiters are built in `createApp` (`src/app.ts:467-481`) and mounted on named routes only.

## 3. Public surface

### 3.1 Routes

The full entries, with response bodies and the error envelope, are in [../api/platform.md](../api/platform.md) (section "Health").

| Method | Path | Authentication | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/health/live` | none | Always `200 {"status":"ok"}`. It does not touch the database (`src/modules/health/health.router.ts:14-16`; test `tests/app.test.ts`, "reports liveness without touching the database"). |
| `GET` | `/health/ready` | none | Runs `databaseProbe.check()`. Success is `200 {"status":"ok"}` (`src/modules/health/health.router.ts:31`). Any exception becomes `AppError` `503 infrastructure.database_unavailable`, title `Service unavailable`, detail `The database dependency is unavailable.`; the original exception is kept as the error's `cause` and is not sent to the client (`src/modules/health/health.router.ts:19-29`). |

> Pending #244: the error handler stops sending `AppError.detail` for any 5xx. The `/health/ready` `503` keeps its code and title, but its detail becomes the fixed sentence `The service is temporarily unavailable. Please try again later.` instead of `The database dependency is unavailable.` (`src/shared/http/error-handler.ts:13`, `:30`, `:86-88` at the PR head; the exception is still logged under the same `trace_id`).
>
> Pending #245 (stacked on #244): both routes send their body through `sendValidated` (`src/modules/health/health.router.ts:16`, `:32` at the PR head), so a body that fails `healthResponseSchema` becomes `500 internal.response_invalid` (`src/shared/http/send-validated.ts:44` at the PR head) instead of `422 validation.invalid_field`.

### 3.2 Jobs, queues, CLI, events

None. The module enqueues nothing, consumes no queue, has no command and writes no audit row.

## 4. Tables

None owned, none read through a repository. The only database access is the `SELECT 1` of the probe. The schema map is in [../data-model.md](../data-model.md).

## 5. Domain rules

None. There is no `domain/` directory. The two behaviours above are the whole rule set: liveness is unconditional, readiness is exactly "the database answers `SELECT 1`".

## 6. Interaction with other modules

None. The module imports `AppError` from `src/shared/errors/app-error.ts` and the `DatabaseProbe` type from `src/infrastructure/database/database-probe.ts` only (`src/modules/health/health.router.ts:4-5`).

## 7. Configuration

The module reads no environment variable. The port and host the probe is served on are the API's own `HOST` and `PORT` (`src/config/environment.ts:9-10`), described in [../configuration.md](../configuration.md). The two compose files call `http://localhost:3000/health/ready` inside the container (`docker-compose.yml:137`, `docker-compose.staging.yml:264`).

## 8. Existing guides

None specific to this module. Operational use of the probes is in [../operations.md](../operations.md); the worker probe and its heartbeat are in [../jobs-and-workers.md](../jobs-and-workers.md).

## 9. Tests

| File | What it checks |
| --- | --- |
| `tests/app.test.ts` | `GET /health/live` returns `200 {status:"ok"}` and does not call the probe; `GET /health/ready` returns `503` with the stable error envelope and `trace_id` when the probe throws; CORS behaviour is exercised on `/health/live`. |
| `tests/worker-heartbeat.test.ts` | The worker's probe (`WorkerHeartbeat`), not this module's router. |

There is no integration test that runs the readiness probe against a real database.

## 10. Where to put a change

| Change | Place |
| --- | --- |
| Make readiness depend on another system (Redis, pg-boss, object storage) | Add a probe interface next to `DatabaseProbe` in `src/infrastructure/`, pass it to `createHealthRouter` as a second argument, build it in `src/server.ts` where `databaseProbe` is built (`:579`) and add the field to `AppDependencies` (`src/app.ts:257`). Keep the router free of infrastructure imports other than the probe interfaces. |
| Change what a failed probe answers | `src/modules/health/health.router.ts:19-29`. The envelope itself is built in `src/shared/http/error-handler.ts`. |
| Add a worker-side check | `src/shared/health/worker-heartbeat.ts`, not this module. |

## 11. Known limitations

| Limitation | Evidence |
| --- | --- |
| Readiness checks the database only. A failure of pg-boss, the rate-limit cache, the profile cache, object storage, ClamAV or the chain RPC does not make `/health/ready` fail. | `src/modules/health/health.router.ts:18-32`, `src/infrastructure/database/database-probe.ts` (`SELECT 1` only). |
| Every `/health/ready` call runs a query; the route has no limiter. | `src/modules/health/health.router.ts:20`; no limiter is mounted at `src/app.ts:590`. |
| The API's shutdown handler calls `server.close` and then closes its connections; it does not change what `/health/ready` answers while it drains. | `src/server.ts:761-784`. |
| The worker's readiness is "ready flag set and a timer tick within 30 seconds"; it does not look at the database, pg-boss or the last job. A worker whose pg-boss connection is lost can still answer ready. | `src/shared/health/worker-heartbeat.ts:6-7`, `src/shared/health/worker-heartbeat.ts:67-76`, `src/shared/health/worker-heartbeat.ts:95-97`. |

No issue in the issue map covers these.

## 12. Known gaps between the code and the design record

Not compared with the record: the record's expectations for probe semantics were not read for this page, so this chapter claims no gap and excludes none.

## 13. Not verified

- How the production load balancer or orchestrator uses the probes; the repository contains the Docker health checks only.
- The behaviour of `SELECT 1` against PostgreSQL 18 (local checks ran on 16.15).
