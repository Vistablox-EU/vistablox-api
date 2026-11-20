# Module: rental

Valid for main at 48aa967 (2026-11-18).

The `rental` module turns recorded rent collections into calculated operating distributions: how much of a property's rent each holder of a position would be paid for one period. It has no router, no route and no command, and it is built but dormant: its only entry point is a monthly worker job that exists only when `OPERATING_DISTRIBUTION_ENABLED` is `true`, and nothing on main writes the rows the job reads. Read this page before you wire anything to rent or distribution data, so you know what is a stub and what is a calculation.

## 1. Purpose and bounded context

| Question | Answer |
| --- | --- |
| What does the module do? | For one property vehicle (`PIV`) and one period it computes a distributable net amount, divides it by the units held, and stores one `calculated` distribution with one entry per holder who has a wallet (`src/modules/rental/application/calculate-operating-distribution.service.ts:49-159`). It pays nothing: no code on main moves a distribution past `calculated` or writes `approved_at`, `approved_by`, `completed_at`, `chain_tx_hash` or `paid_at`. |
| Status | Built, dormant and partly a stub. The calculation, its persistence and the monthly sweep exist and have been written ahead of any property that collects rent (`src/modules/rental/domain/operating-distribution.policy.ts:1-16`). The three deductions are fixed placeholders of `0.00` (`src/modules/rental/application/run-operating-distribution-sweep.service.ts:18`, `src/modules/rental/application/run-operating-distribution-sweep.service.ts:35-37`). There is no way to enter a rent collection, so the sweep's work list is empty unless someone inserts a row by hand. |
| Who calls it? | Only `src/worker.ts`, when `OPERATING_DISTRIBUTION_ENABLED` is `true`: it builds `RunOperatingDistributionSweepService`, creates the queue `rental.operating_distribution_sweep`, schedules it monthly and registers its consumer (`src/worker.ts:211-219`, `src/worker.ts:429-431`, `src/worker.ts:536-545`, `src/worker.ts:626-629`). The API process does not import the module. |
| What it does not own | Rent collection entry (no process exists), approval of a distribution, payment, the investor-facing view of a distribution, tenancy, leases and maintenance. The design record scopes the `Rental` domain to boundary only (section 12). |
| Who reads its output? | Nobody: no route, job or module reads `settlement.operating_distributions` or `settlement.operating_distribution_entries` on main. |

## 2. File map

| Layer | File | Lines | Responsibility |
| --- | --- | --- | --- |
| api | none | | No router and no schema file. |
| application | `src/modules/rental/application/run-operating-distribution-sweep.service.ts` | 52 | `RunOperatingDistributionSweepService.execute()`: lists rent collections that have no distribution and calls the calculation for each, with the three deductions fixed to `"0.00"`. Returns a `JobRunSummary` `{ checked, acted }`; `acted` counts distributions that were not already calculated. |
| application | `src/modules/rental/application/calculate-operating-distribution.service.ts` | 176 | `CalculateOperatingDistributionService.execute(input)`: idempotent calculation and persistence of one distribution; interfaces `CalculateOperatingDistributionInput` and `CalculateOperatingDistributionResult`; private micro-unit helpers `toMicroUnits` and `fromMicroUnits` for summing unit counts. |
| domain | `src/modules/rental/domain/operating-distribution.policy.ts` | 90 | Pure decimal arithmetic on strings through `BigInt` millionths: `computeDistributableNet`, `computeAmountPerUnit`, `computeEntryAmount` (section 5). |
| repository | `src/modules/rental/repository/operating-distribution.repository.ts` | 103 | Interface `OperatingDistributionRepository` and its input and record types. |
| repository | `src/modules/rental/repository/prisma-operating-distribution.repository.ts` | 156 | `PrismaOperatingDistributionRepository`: the only implementation. Reads active position holders and writes one distribution with its entries in one transaction. |

Wiring: `src/worker.ts:211-219` builds the repository, the calculation service and, only when the flag is on, the sweep service. `src/server.ts` does not import the module.

## 3. Public surface

### 3.1 Routes, CLI, events

None. The module has no HTTP route, no `npm run` command, no audit row and no event. Nothing in `src/cli` or `package.json` refers to it.

### 3.2 Jobs and queues

| Queue | Kind | Trigger | Handler | Exists when |
| --- | --- | --- | --- | --- |
| `rental.operating_distribution_sweep` | scheduled, owner `settlement`, tier `tier_1` (`src/shared/jobs/job-ownership.ts:33`) | `0 6 1 * *` UTC, 06:00 on the first of each month, null payload (`src/worker.ts:536-545`) | `RunOperatingDistributionSweepService.execute` through `runJob` (`src/worker.ts:626-629`) | `OPERATING_DISTRIBUTION_ENABLED=true` |

Queue behaviour, retries and dead-lettering are described in [../jobs-and-workers.md](../jobs-and-workers.md) (entry `rental.operating_distribution_sweep`). The queue's owner in the ownership table is `settlement`, the name of the database schema that holds the distribution tables, although the code lives in the `rental` module.

### 3.3 What the sweep does

1. `listRentCollectionsAwaitingDistribution` reads every `rental.rent_collections` row whose `distribution` relation is null (`src/modules/rental/repository/prisma-operating-distribution.repository.ts:21-26`).
2. For each, `CalculateOperatingDistributionService.execute` is called with the collection's gross rent and three deductions of `"0.00"` (`src/modules/rental/application/run-operating-distribution-sweep.service.ts:30-46`).
3. The calculation looks for an existing distribution for `(piv_id, period_start, period_end)` and returns it with `alreadyCalculated: true` if there is one (`src/modules/rental/application/calculate-operating-distribution.service.ts:52-68`).
4. Otherwise it finds the rent collection for the period, and records one if none exists (`src/modules/rental/application/calculate-operating-distribution.service.ts:70-84`); the sweep always passes an existing one, so the recording branch is not reached from the sweep.
5. It computes the distributable net, lists the `active` positions of the vehicle, sums their units, computes the per-unit amount, and builds one entry for every holder with a wallet address; holders without one are returned in `skippedNoWalletPositionIds` and get no entry (`src/modules/rental/application/calculate-operating-distribution.service.ts:86-132`).
6. `createOperatingDistribution` writes the distribution and all its entries in one transaction (`src/modules/rental/repository/prisma-operating-distribution.repository.ts:101-137`).

The skipped holders are only returned to the caller; the sweep reads only `alreadyCalculated` from the result and nothing logs or stores them (`src/modules/rental/application/run-operating-distribution-sweep.service.ts:47`).

## 4. Tables

| Table | Access | Notes |
| --- | --- | --- |
| `rental.rent_collections` | read; insert (calculation fallback only) | One row per `(piv_id, period_start, period_end)`: gross rent, `recorded_by` (an account), notes. Comment in the schema: a minimal slice of the `Rental` domain, enough to feed distributions (`prisma/schema/schema.prisma:987-1008`). |
| `settlement.operating_distributions` | read, insert | One row per `(piv_id, period_start, period_end)` and one per rent collection; `status` default `calculated`; `approved_at` and `approved_by` are the governance checkpoint the schema comment names (`prisma/schema/schema.prisma:1010-1043`). The table is in the `settlement` database schema although this module writes it. |
| `settlement.operating_distribution_entries` | insert | One row per `(distribution, position)`: units at the record date, EURC amount, destination wallet; `chain_tx_hash` and `paid_at` stay null (`prisma/schema/schema.prisma:1045-1063`). |
| `settlement.position_ledger` | read | Positions of the vehicle with status `active` (`src/modules/rental/repository/prisma-operating-distribution.repository.ts:16`, `src/modules/rental/repository/prisma-operating-distribution.repository.ts:60-62`). |

The three tables and the `rental` schema were created by migration `20260903170000_add_operating_distributions` (`prisma/migrations/20260903170000_add_operating_distributions/migration.sql:2`, `:5`, `:19`, `:43`). Model definitions are in [../data-model.md](../data-model.md).

## 5. Domain rules

All rules are in `src/modules/rental/domain/operating-distribution.policy.ts`; money and unit counts are decimal strings and the arithmetic is `BigInt` millionths, never `number`.

| Rule | Where |
| --- | --- |
| Distributable net is gross rent minus management fee, other expenses and reserve holdback, floored at zero; a loss period distributes nothing. | `computeDistributableNet`, `src/modules/rental/domain/operating-distribution.policy.ts:49-72` |
| The net is truncated, not rounded, to whole cents, so a fraction of a cent stays undistributed. | `src/modules/rental/domain/operating-distribution.policy.ts:64-71` |
| The per-unit amount is `net / total units` computed at micro-of-micro precision and returned with six decimals; total units must be positive. | `computeAmountPerUnit`, `src/modules/rental/domain/operating-distribution.policy.ts:74-85` |
| A holder's amount is `units * per-unit amount`, truncated to six decimals; the sum over all holders never exceeds the net (test "never distributes more than the distributable net across all holders"). | `computeEntryAmount`, `src/modules/rental/domain/operating-distribution.policy.ts:87-90` |
| A period with no active units records a distribution with per-unit amount `0.000000` and no entries instead of dividing by zero. | `src/modules/rental/application/calculate-operating-distribution.service.ts:106-112` |
| Only positions with status `active` take part; `pending_internal_settlement` and `redeemed` do not. | `src/modules/rental/repository/prisma-operating-distribution.repository.ts:16`, `:60-62` |
| A holder whose position has no `holder_wallet_address` is skipped, not failed. | `src/modules/rental/application/calculate-operating-distribution.service.ts:114-122` |
| Re-running a period returns the existing distribution and creates nothing. | `src/modules/rental/application/calculate-operating-distribution.service.ts:52-68`; database uniqueness `uq_operating_distributions_piv_period`, `prisma/schema/schema.prisma:1039` |
| A distribution and its entries are written in one transaction. | `src/modules/rental/repository/prisma-operating-distribution.repository.ts:105-135` |

State machine: the schema defines `status` with default `calculated` and the comment names a `paying` state (`prisma/schema/schema.prisma:1010-1013`, `:1028`). Only `calculated` is ever written. No transition code exists.

## 6. Interaction with other modules

| Other module | Direction | How |
| --- | --- | --- |
| `settlement` | reads its table | Reads `settlement.position_ledger` through Prisma. Which positions are `active` is decided elsewhere: the only code that writes `position_status = 'active'` is the escrow mint recording in `settlement` (`src/modules/settlement/repository/prisma-settlement.repository.ts:483`). Positions made by the reservation flow stay `pending_internal_settlement` (`src/modules/offering/repository/prisma-offering.repository.ts:1474-1483`), so on main only escrow-minted positions can take part. |
| `wallet` | indirect | The destination address is the position's copied `holder_wallet_address`, not a read of `wallet_registrations` (`src/modules/rental/repository/prisma-operating-distribution.repository.ts:60-72`). |
| `account` | foreign keys | `recorded_by` and `approved_by` point at `account.accounts`. |
| Jobs and events | none | The module neither enqueues nor consumes a cross-module job. |

No module imports `rental`; `rental` imports only `src/shared/jobs/job-run-summary.ts`, `src/infrastructure/database/prisma.ts` and the `ulid` package (`src/modules/rental/application/run-operating-distribution-sweep.service.ts:1`, `src/modules/rental/repository/prisma-operating-distribution.repository.ts:1-3`).

## 7. Configuration

| Variable | Effect |
| --- | --- |
| `OPERATING_DISTRIBUTION_ENABLED` | `true` or `false`, default `false` (`src/config/environment.ts:280-283`, `.env.example:200`). Read by the worker only. The staging compose anchor does not set it; it reaches the containers only through the host's `.env.staging`, which is not in the repository. |

The full list is in [../configuration.md](../configuration.md).

## 8. Existing guides

None. The only prose is in the code comments (`src/modules/rental/domain/operating-distribution.policy.ts:1-16`, `src/modules/rental/application/run-operating-distribution-sweep.service.ts:6-16`) and in the schema comments.

## 9. Tests

| File | What it covers |
| --- | --- |
| `tests/operating-distribution-policy.test.ts` | The three policy functions: deductions, floor at zero, sub-cent per-unit precision, zero and negative total units, and the invariant that the sum of the entries never exceeds the net. |

No test covers `CalculateOperatingDistributionService`, `RunOperatingDistributionSweepService`, `PrismaOperatingDistributionRepository` or the worker wiring; no integration test touches the three tables.

## 10. Where to put a change

| Change | Place |
| --- | --- |
| Enter a rent collection (a staff route or a command) | A new service and repository method in this module; the repository already has `recordRentCollection`. A route follows the staff-route pattern in [../api/README.md](../api/README.md) and needs a new section in the API chapter. Decide first who may enter it: the design record has no such process. |
| Real management fee, expenses and holdback | Replace `PLACEHOLDER_ZERO_EUR` in `src/modules/rental/application/run-operating-distribution-sweep.service.ts:18` with a per-vehicle source; the policy already takes the three amounts. |
| Approve or pay a distribution | New services for the `approved_at`/`paying` states; the schema fields exist. Any chain payment is a platform chain write and must take the operator-key lock described in [settlement.md](settlement.md). |
| Show a distribution to an investor | Not here: a new list in [investor-activity.md](investor-activity.md) once the record defines it. |
| Change the rounding | `src/modules/rental/domain/operating-distribution.policy.ts` and `tests/operating-distribution-policy.test.ts` together; the "never more than the net" invariant must still hold. |

## 11. Known limitations

| Limitation | Evidence | Issue |
| --- | --- | --- |
| The three deductions are hardcoded to `0.00`, so every distribution equals the gross rent. The file says so itself. | `src/modules/rental/application/run-operating-distribution-sweep.service.ts:10-16`, `src/modules/rental/application/run-operating-distribution-sweep.service.ts:18`, `src/modules/rental/application/run-operating-distribution-sweep.service.ts:35-37` | none |
| No code, route or command writes `rental.rent_collections`; the sweep's work list is empty unless a row is inserted by hand. | `src/modules/rental/repository/prisma-operating-distribution.repository.ts:21-26`, `src/modules/rental/repository/prisma-operating-distribution.repository.ts:44-58`; no other writer under `src` | none |
| Holders without a wallet are skipped and only reported in a result field that the sweep drops; what happens to their share later is undecided in the code comment. | `src/modules/rental/application/calculate-operating-distribution.service.ts:25-31`, `src/modules/rental/application/run-operating-distribution-sweep.service.ts:47` | none |
| A reservation-flow position never reaches `active` on main, so it never receives a distribution; only escrow-minted positions do. | `src/modules/rental/repository/prisma-operating-distribution.repository.ts:16`, `src/modules/settlement/repository/prisma-settlement.repository.ts:483` | none |
| `listRentCollectionsAwaitingDistribution` reads every undistributed collection with no limit, and one failing calculation stops the run (no per-collection error handling), so the remaining collections wait for the retry. | `src/modules/rental/repository/prisma-operating-distribution.repository.ts:21-26`, `src/modules/rental/application/run-operating-distribution-sweep.service.ts:30-47` | none |
| The check-then-insert in the calculation is not atomic: two concurrent runs for one period both pass the existence check and the second insert fails on the unique constraint (`uq_operating_distributions_piv_period`), which the job then retries. | `src/modules/rental/application/calculate-operating-distribution.service.ts:52-68`, `prisma/schema/schema.prisma:1039` | none |
| The two `settlement` distribution tables have no amount or status check constraint; migration `20261018131001_money_ledger_amount_and_status_checks` leaves them out on the ground that the record gives them no schema to constrain them against. `rental.rent_collections` is not mentioned there. | `prisma/migrations/20261018131001_money_ledger_amount_and_status_checks/migration.sql:55-58` | none |
| No unit or integration test covers the services or the repository. | section 9 | none |

## 12. Known gaps between the code and the design record

| Statement in the record | Code | Register |
| --- | --- | --- |
| `CORE_TABLES.md` says ongoing investor distributions "have no schema here — deliberately" and `AD-206` narrows phase 1 to not tracking them (`04-Engineering/DATA/CORE_TABLES.md:521`). | The migration `20260903170000_add_operating_distributions` creates `rental.rent_collections`, `settlement.operating_distributions` and `settlement.operating_distribution_entries`; the comments say they were built at the founder's direction ahead of the trigger. | No register entry. No decision in the ledger that this page's search found records that direction. |
| `AD-232` scopes `Rental` to a domain boundary with no schema, and says the operating distribution waterfall is not owned by `Rental` and stays deferred. | The code has a module and a schema named `rental`, and the distribution calculation lives in it. | No register entry. |
| `CORE_TABLES.md` documents eight schemas and no `rental` schema. | `prisma/schema/schema.prisma:8` lists ten, including `rental`. | No register entry for the `rental` schema; C-018 covers only `origination` against `intake`. |
| `AD-089`'s alert scope covers the `money_ops` and `settlement` queues. | `rental.operating_distribution_sweep` has owner `settlement` and tier `tier_1`, so a failure dead-letters and alerts. | C-022 notes that the record does not say which code queues the scope covers. |

Register entries are in `00-Governance/MIGRATION/CONFLICT_REGISTER.md` on the `origin/main` of the design-record repository; the working checkout read for this page lacks C-009 onward. The record was not edited.

## 13. Not verified

- Whether a staging or production database holds any row in the three tables; only the code was read.
- The behaviour of the monthly cron under a real pg-boss instance with the flag on; the worker was not run.
- Any property-management or fee terms: the design record says none exist (`AD-236`).
