# Module: investor-activity

Valid for main at 48aa967 (2026-11-18).

The `investor-activity` module serves the signed-in customer's own reservation history and current positions as two cursor-paginated, read-only lists, and offers a count-only reader to the `profile` module. It writes nothing. Read this page before you change what an investor sees about their reservations or holdings, or when you need to know which module writes the rows it lists.

## 1. Purpose and bounded context

| Question | Answer |
| --- | --- |
| What does the module own? | `GET /v1/investor-profile/reservations` and `GET /v1/investor-profile/positions`, both mounted on the `/v1/investor-profile` prefix that the `profile` and `wallet` routers share (`src/modules/investor-activity/api/investor-activity.router.ts:20`, `src/modules/investor-activity/api/investor-activity.router.ts:30`, `src/app.ts:875-885`). |
| What does it read? | `offering.reservations` with their offering, `intake.pivs` and `intake.properties`, the newest `money.money_events` row of each reservation, and `settlement.position_ledger` (`src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:43-92`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:127-168`). |
| What does it write? | Nothing: no insert, update or audit row in any layer. |
| Who writes the rows it lists? | Reservations and money events are written by the `offering` module (reservation creation, onramp recording, finalisation); positions are written by the `offering` module for the reservation flow (the reconfirmation-window close job) and by the `settlement` module for an escrow mint (comment on `reservationId`, `src/modules/investor-activity/repository/investor-activity.repository.ts:79-80`; the writes are `src/modules/offering/repository/prisma-offering.repository.ts:1474-1483` and `src/modules/settlement/repository/prisma-settlement.repository.ts:472-486`). |
| Who may call it? | Customers only. A staff or partner session passes `requireAuthentication` and is then refused in the handler with `403 authorization.forbidden` (`src/modules/investor-activity/api/investor-activity.router.ts:43-63`). |
| What it deliberately leaves out | Provider names and references, wallet addresses and redeemed positions: the money event is reduced to `{ state, amount_eur, amount_eurc, recorded_at }` and only two position statuses are selected (`src/modules/investor-activity/api/investor-activity.schemas.ts:35-50`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:130`). |

## 2. File map

| Layer | File | Lines | Responsibility |
| --- | --- | --- | --- |
| api | `src/modules/investor-activity/api/investor-activity.router.ts` | 63 | `createInvestorActivityRouter(requireAuthentication, listReservations, listCurrentPositions)`: `GET /reservations` and `GET /positions`, each parsing the query with `investorActivityQuerySchema`, setting `Cache-Control: no-store` and parsing the result with its response schema. `requireCustomerContext` enforces the customer population. |
| api | `src/modules/investor-activity/api/investor-activity.schemas.ts` | 79 | `investorActivityQuerySchema` (`limit` 1 to 100, default 20; `after` a non-empty string), `investorReservationHistoryResponseSchema`, `investorCurrentPositionsResponseSchema`; the closed value lists of the stage, status and capital-state enums. |
| application | `src/modules/investor-activity/application/list-investor-activity.service.ts` | 185 | `ListInvestorReservationsService` and `ListInvestorCurrentPositionsService`: decode the cursor, ask the repository for `limit + 1` rows, cut the page, map camelCase records to the snake_case wire shape, encode the next cursor. Also the exported cursor codecs `encodeReservationCursor`, `decodeReservationCursor`, `encodePositionCursor`, `decodePositionCursor` (base64url JSON; a bad cursor is `422 pagination.invalid_cursor`). |
| domain | none | | The module has no `domain/` directory and no policy class. |
| repository | `src/modules/investor-activity/repository/investor-activity.repository.ts` | 89 | Interfaces `InvestorActivityRepository` (the two list methods), `InvestorActivitySummaryReader` (`getSummary`), the cursor types and the record types. |
| repository | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts` | 246 | `PrismaInvestorActivityRepository` implements both interfaces. Maps stored strings to the closed unions and throws a plain `Error` for a value it does not know (`asReservationStage`, `asOfferingStatus`, `asCapitalState`, `asCurrentPositionStatus`, `toPropertySummary`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:184-246`). |

Wiring: `src/server.ts:569` builds one `PrismaInvestorActivityRepository`; `src/server.ts:575` hands the same instance to `PrismaProfileRepository` as its summary reader; `src/server.ts:694-696` passes it to `createApp` as `protectedApi.investorActivity`; `src/app.ts:875-885` builds the two services and mounts the router when that dependency is present. `src/server.ts` always supplies it, so the routes exist whenever the protected API exists.

> Pending #237: the mount moves from `src/app.ts` into `src/composition/compose-investor-profile.ts`, together with the profile and wallet mounts; the router, services and repository do not change.

## 3. Public surface

### 3.1 Routes

The full entries, with every response field, are in [../api/platform.md](../api/platform.md) (section "Investor activity").

| Method | Path | Authentication | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/v1/investor-profile/reservations?limit=&after=` | `requireAuthentication`, customer population | The caller's reservations of every stage, newest first (`created_at`, then `id`), with the offering status, the newest money event as `latest_capital_state` and a residential property summary (`src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:43-120`). |
| `GET` | `/v1/investor-profile/positions?limit=&after=` | `requireAuthentication`, customer population | The caller's positions whose status is `pending_internal_settlement` or `active`, ordered by `activated_at` descending with nulls last, then `id` descending (`src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:127-181`). `reservation_id` and `offering_id` are `null` for a position that has no reservation (`src/modules/investor-activity/api/investor-activity.schemas.ts:61-67`). |

Both answer `Cache-Control: no-store` (`src/modules/investor-activity/api/investor-activity.router.ts:27`, `src/modules/investor-activity/api/investor-activity.router.ts:37`). The account filter is the account id of the session, never a request parameter (`src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:45`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:129`). Neither route requires fresh authentication or an `Idempotency-Key`; the baseline rate limiter runs inside `requireAuthentication`.

> Pending #244: the router sends its body through `sendValidated`, so a body that fails its response schema becomes `500 internal.response_invalid` instead of `422 validation.invalid_field`; #245 does the same for the routers #244 does not cover.

### 3.2 Reader for other modules

`InvestorActivitySummaryReader.getSummary(accountId)` returns `{ reservationCount, activePositionCount }` (`src/modules/investor-activity/repository/investor-activity.repository.ts:20-27`). `PrismaInvestorActivityRepository.getSummary` is one `account` lookup with a relation count: all reservations of the account, and positions whose status is `pending_internal_settlement` or `active` (`src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:16-36`). The `profile` module is the only caller; it shows the two numbers as `investment_summary.reservation_count` and `investment_summary.active_position_count` (`src/modules/profile/application/get-profile.service.ts:84-85`).

### 3.3 Jobs, queues, CLI, events

None. The module enqueues nothing, consumes no queue, has no command and writes no audit row.

## 4. Tables

| Table | Access | Notes |
| --- | --- | --- |
| `offering.reservations` | read | Index `idx_reservations_account` on `account_id` serves the filter; the sort key `(created_at, reservation_id)` has no composite index (`prisma/schema/schema.prisma:616-640`). |
| `offering.offerings`, `intake.pivs`, `intake.properties` | read (joined) | For `status`, `property_type`, `country_code` and `city` (`src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:69-79`). |
| `money.money_events` | read | Newest per reservation: order `recorded_at` descending then `money_event_id` descending, `take: 1`; index `idx_money_events_reservation_recorded` (`prisma/schema/schema.prisma:696-711`). |
| `settlement.position_ledger` | read | Indexes on `reservation_id`, `piv_id` and `account_id`; none on `activated_at` (`prisma/schema/schema.prisma:851-885`). |

The model definitions are in [../data-model.md](../data-model.md).

## 5. Domain rules

There is no `domain/` directory. The rules below sit in the service and the repository:

| Rule | Where |
| --- | --- |
| Page size: `limit` defaults to 20 and is 1 to 100; the repository is asked for `limit + 1` rows and a next cursor is issued only when the extra row exists. | `src/modules/investor-activity/api/investor-activity.schemas.ts:5-8`; `src/modules/investor-activity/application/list-investor-activity.service.ts:34-41`, `src/modules/investor-activity/application/list-investor-activity.service.ts:95-102` |
| A cursor is base64url JSON carrying its kind (`investor_reservations` or `investor_positions`), so a cursor from one list is refused by the other. | `src/modules/investor-activity/application/list-investor-activity.service.ts:11-21`, `src/modules/investor-activity/application/list-investor-activity.service.ts:133-161` |
| Reservation paging is keyset paging on `(created_at, id)` descending. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:46-58` |
| Position paging is keyset paging on `(activated_at desc nulls last, id desc)`; a cursor whose `activated_at` is null continues inside the null group, one with a date continues with earlier dates and then the whole null group. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:131-149` |
| The current-portfolio view is the two statuses `pending_internal_settlement` and `active`; `redeemed` (written by nothing on main, see [settlement.md](settlement.md)) would be excluded. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:130` |
| Amounts are fixed-point strings: EUR with two decimals, EURC and unit counts with six. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:101`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:113-114`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:175-176` |
| An unknown stored value is a hard failure, not a fallback. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:184-246`; test `tests/investor-activity-repository.test.ts`, "fails closed on a capital state it does not recognise" |

State machines of the reservation (`reservation_stage`, `capital_state`) and of the position are owned by the `offering` and `settlement` modules; see [offering.md](offering.md) and [settlement.md](settlement.md).

## 6. Interaction with other modules

| Other module | Direction | How |
| --- | --- | --- |
| `profile` | profile reads | `InvestorActivitySummaryReader` type imported from `src/modules/investor-activity/repository/investor-activity.repository.ts` (`src/modules/profile/repository/prisma-profile.repository.ts:4`), met by the shared repository instance (`src/server.ts:575`). A type-only import of another module's `repository` directory, not a job. |
| `offering`, `settlement` | they write | Nothing is imported in either direction. The module reads their tables through Prisma relations; the shape of those tables is the contract. |
| `wallet` | shares a prefix | The wallet router is mounted on `/v1/investor-profile/wallet`, the activity router on `/v1/investor-profile`; the paths do not overlap (`src/app.ts:837-863`, `src/app.ts:875-885`). |
| Jobs and events | none | |

## 7. Configuration

The module reads no environment variable. The rate limiter in `requireAuthentication` uses `RATE_LIMIT_CACHE_URL`; see [../configuration.md](../configuration.md).

## 8. Existing guide

[../investor-profile.md](../investor-profile.md) describes both routes (bullets on reservation history and current positions) together with the profile and the wallet. The API reference is [../api/platform.md](../api/platform.md).

## 9. Tests

| File | What it covers |
| --- | --- |
| `tests/investor-activity-service.test.ts` | Page cut with `limit + 1`, opaque next cursor, position paging without wallet data, rejection of malformed and cross-endpoint cursors. |
| `tests/investor-activity-api.test.ts` | Both routes answer `200` with `no-store` for a customer and an empty page; a staff context is refused; an escrow-minted position with null `reservation_id` and `offering_id` is served. |
| `tests/investor-activity-repository.test.ts` | `listReservations` with a stubbed database: no money event, a known capital state, an unknown state fails with `Unknown capital state: ...`, and every capital state the development fixture `tmp/create-dev-intake-fixture.ts` writes is readable. |
| `tests/profile-wallet-activity-repository.integration.test.ts` | Against a database: account-scoped reservation paging with only the latest money state, active before pending positions, redeemed excluded, an escrow-minted position next to reservation-backed ones, the summary counts. Skipped without `TEST_DATABASE_URL`; see [../testing.md](../testing.md). |
| `tests/money-ledger-integrity.integration.test.ts` | Uses the `InvestorPositionRecord` type to keep the position statuses in code in step with the database constraint. |

## 10. Where to put a change

| Change | Place |
| --- | --- |
| A new field on a reservation or position row | The record type in `src/modules/investor-activity/repository/investor-activity.repository.ts`, the `select` in `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts`, the mapping in `src/modules/investor-activity/application/list-investor-activity.service.ts` and the response schema in `src/modules/investor-activity/api/investor-activity.schemas.ts`. |
| A new reservation stage, capital state or position status | The writer module first; then the unions and `as...` guards in the repository, the enums in the schema file, and `tests/investor-activity-repository.test.ts`. Until this is done a row with the new value makes the whole list answer `500`. |
| A third list (for example payouts) | New route in the router, new service in `list-investor-activity.service.ts`, a new cursor `kind`, a new repository method. |
| A count for another module | A method on `InvestorActivitySummaryReader`; keep it a read. |
| Anything that creates or changes a reservation or position | `offering` or `settlement`, not here. |

## 11. Known limitations

| Limitation | Evidence | Issue |
| --- | --- | --- |
| One stored value outside the closed lists (a reservation stage, offering status, capital state, position status or property type) fails the whole page with `500 internal.unexpected`. A development fixture once wrote `eurc_cancelled` and broke the staging list. The behaviour is pinned by a test as intentional. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:184-246`; `tests/investor-activity-repository.test.ts` (comment before "reads every capital state the development fixture writes") | none |
| `investment_summary.reservation_count` counts every reservation of the account, including `cancelled` and `lapsed`; only the position count is filtered by status. | `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:21-27` | none |
| A position created by the reservation flow keeps the status `pending_internal_settlement` and a null `activated_at`; no code on main moves an existing position to `active` (the only writes of `position_status` are the column default at reservation finalisation and `active` at creation of an escrow-minted position). The position cursor carries `activated_at`. | `src/modules/offering/repository/prisma-offering.repository.ts:1474-1483`, `src/modules/settlement/repository/prisma-settlement.repository.ts:483`, `src/modules/investor-activity/repository/prisma-investor-activity.repository.ts:146-149` | none |
| No index supports the position sort (`activated_at`, `position_id`) or the reservation sort (`created_at`, `reservation_id`); the account index narrows the scan and the sort is done on the matching rows. | `prisma/schema/schema.prisma:636-638`, `prisma/schema/schema.prisma:881-883` | none |
| A response that fails its schema surfaces as `422 validation.invalid_field` with internal field paths and is not logged (the route uses `schema.parse`). | `src/modules/investor-activity/api/investor-activity.router.ts:28`, `src/modules/investor-activity/api/investor-activity.router.ts:38`, `src/shared/http/error-handler.ts:39-41`, `src/shared/http/error-handler.ts:51-64` | none (see pending #244, #245) |
| `profile` imports a type from this module's `repository` directory. The architecture check ignores type-only imports, so it does not report it. | `src/modules/profile/repository/prisma-profile.repository.ts:4`, `dependency-cruiser.config.cjs:1-35` | #122 (closed by #202; the work is listed as not done) |

## 12. Known gaps between the code and the design record

- The closed lists in this module follow what the code writes, not the record's lists: `reservation_stage` has six values here (`src/modules/investor-activity/api/investor-activity.schemas.ts:23-30`) against the record's eight, and `latest_capital_state.state` includes `eurc_reserved` (`src/modules/investor-activity/api/investor-activity.schemas.ts:37-45`), which the record's `capital_state` list does not (`04-Engineering/DATA/CORE_TABLES.md:475-478`, `:531-534`). These are G8 and G9 in [../data-model.md](../data-model.md), recorded under C-007 items 1, 2 and 10 (AD-253, AD-260).

Not verified: the record's definitions of the investor reservation history and portfolio views were not compared with the response shape for this page.

## 13. Not verified

- Behaviour of the keyset queries on PostgreSQL 18 and with production data volumes; local checks ran on 16.15 and no query plan was read.
- Whether the staging host serves these routes behind the same proxy settings as the other `/v1` routes (`.env.staging` is not in the repository).
