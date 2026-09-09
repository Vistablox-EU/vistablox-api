# KYC eligibility read model

Built in Phase 7 of the KYC microservicing effort, on an explicit mandate: `identity`'s `KycEligibility` table should be reached only through the KYC service, not a direct Prisma query from the three modules that gate their own logic on it. Origination, offering, and investor-profile now each keep a small local projection of [`KycEligibilitySnapshot`](../src/modules/identity/repository/kyc-eligibility-reader.ts), kept in sync by pg-boss publish/subscribe rather than an in-process read of `identity`'s own table.

## Why event-driven

Two things already true about this codebase made the choice easy, and both are worth restating so a future reader doesn't have to re-derive them:

`CreateReservationService` — the one consumer with money on the line — reads eligibility once via `getInvestorDetail`, outside any transaction, and never re-checks it. `computeReservationBlockers`'s own comment in [`reservation-eligibility.policy.ts`](../src/modules/offering/domain/reservation-eligibility.policy.ts) says the read is "advisory only, never a substitute for the atomic check at write time" — but the atomic, transactionally-locked recheck that actually exists at write time (`AD-146`) is capacity, not KYC. So the consistency bar this system already accepted for eligibility, even in the single-database monolith this replaced, was "recent," not "read-your-writes."

`KycEligibility` writes are already asynchronous end-to-end: Didit's webhook durably enqueues via pg-boss, the standalone `kyc-server.ts` process processes it later, and only then does the row change. There was no synchronous read-after-write guarantee for eligibility even before this, in-process.

The alternative — a synchronous call from each of the three consumers to the KYC service for every read — would have coupled `getInvestorDetail` (an offering-detail page view) and investor-profile's `get` (a dashboard read) to that service's uptime, not just the reservation path. An outage in the KYC service would degrade three unrelated read APIs instead of leaving some rows briefly stale. For a financial platform, that broader blast radius was the worse trade.

**The honest cost of this choice, not just its benefit.** Before this, all three consumers read the *same* row through the *same* transaction — they could never disagree with each other about one account's KYC state at a given instant, and `CreateReservationService`'s eligibility read was stale by at most webhook-processing lag (seconds). Now each has its own independently-lagging copy: it's possible for two consumers to disagree with *each other*, not just with a source that hasn't caught up yet, and the worst-case staleness bound moved from "seconds" to "up to the reconcile interval" in a genuinely degraded scenario (a subscriber silently stuck) — a change in category, not just magnitude, since no direct-read architecture can produce an hour of staleness on a row that's already committed. This is why offering's own reconcile job runs every 5 minutes rather than hourly (see Job wiring below) — it's the one projection where that degraded-case bound actually touches money.

## The mechanism

Confirmed against this repo's actual `pg-boss` version (`12.29.0`) by reading `node_modules/pg-boss/dist/manager.js` directly, not assumed:

- `boss.subscribe(event, queueName)` maps a queue to an event topic. Its SQL is `INSERT ... ON CONFLICT (event, name) DO UPDATE` — idempotent, safe to call on every process start, the same convention `createQueue`'s `ON CONFLICT DO NOTHING` already establishes throughout this codebase. `worker.ts` calls it once per consumer at startup.
- `boss.publish(event, data, options)` looks up every queue subscribed to `event` (on pg-boss's own connection, not the caller's transaction — subscriptions are static config, never created or changed mid-transaction, so this is immaterial) and calls `send(name, data, options)` for each. Traced into `createJob()`: the same transaction-bound `db: { executeSql }` adapter `enqueueTransactionalJob` already used for a single queue *is* correctly forwarded to every one of `publish()`'s fanned-out `send()` calls — confirmed directly against source, not assumed. `publishTransactionalEvent` (a sibling to `enqueueTransactionalJob` in [`enqueue-job.ts`](../src/shared/jobs/enqueue-job.ts)) is the one new primitive this required.
- `publish()` with zero subscribed queues is a safe no-op — deployment order between `kyc-server.ts` (publisher) and `worker.ts` (subscriber) doesn't matter.

## Event contract

Topic `identity.kyc_eligibility_changed`. Payload: the full `KycEligibilitySnapshot` shape, not a bare "something changed, go re-fetch" notification — a subscriber never calls back into `identity` to resolve an event.

Published from a private `publishEligibilityChanged` helper on `PrismaKycRepository`, called individually at each of its 9 mutating methods' actual-write-succeeded branch (several have early returns where nothing was written — e.g. `reserveSessionStart`'s lock/state-check failure, `applyProviderOutcome`'s `"duplicate"`/`"unmatched"`/`"stale"` branches — publishing is skipped there). Four methods (`reserveSessionStart`, `reserveProofOfAddressSessionStart`, `applyProviderOutcome`, `applyProofOfAddressOutcome`) capture their own `.upsert()`/`.update()` return value directly, at zero extra query cost; the other five use `.updateMany()` as a compare-and-swap guard and can't, so they re-read the row through the same transaction right before publishing.

## Consumer shape

Each of origination, offering, and investor-profile has one class combining read and write for its own projection (mirroring `PrismaKycRepository`'s own precedent of combining both for one table): `implements KycEligibilityReader` (unchanged from each module's own perspective — `getIntakePrerequisites`, `getInvestorDetail`, and investor-profile's `get` never needed to change, since Phase 1's port was already implementation-agnostic about where `getEligibilitySnapshot` reads from), plus `applyEvent` (one row, called by the subscriber) and `reconcile` (a full diff-then-write sync from `identity.kyc_eligibility`, serving as both cold-start backfill and the ongoing staleness backstop).

Investor-profile's projection table lives in the `account` Prisma schema — investor-profile has no dedicated schema of its own (see [`investor-profile.md`](investor-profile.md)), and `account` was the closest existing affinity.

None of the three projection tables has a foreign key back to `Account`, unlike every other relation in `schema.prisma`. Every accountId a projection ever receives already passed through `KycEligibility`'s own FK to `Account` — directly, via a published event, or via `reconcile`'s own read of that same table — so a second FK here could never actually reject anything; it would be pure ceremony, not real protection. The concrete thing skipping it gives up is a free `ON DELETE CASCADE` if `Account` rows are ever hard-deleted, which no code path does today.

## What the real build didn't skip

**Cold-start backfill.** `reconcile` doubles as this: an empty projection table means every source row counts as drift on the first pass, so a freshly deployed consumer is fully populated by its first reconcile run rather than waiting for events to trickle in per account. `worker.ts` also sends one immediate reconcile job at every start, in addition to each job's own schedule, so this doesn't wait for the first scheduled tick either.

**A staleness backstop.** `reconcile` is diff-then-write, not blind upsert-everything — it compares each source row against the existing projection row and only writes (and counts in its `{checked, acted}` summary) the ones that actually differ. This is what makes offering's 5-minute cadence affordable (a synced table is nearly all reads) and is also what makes the summary a meaningful signal: `acted > 0` means real drift was found and corrected. Alerting on that signal is deliberately not built, matching the same, already-accepted bar `didit-kyc.md`'s stuck-session jobs set: visible via structured logs (`{checked, acted}` on every run), not paged to anyone. `AD-089`'s alert-source scoping doesn't cover any of these `*.kyc_eligibility_reconcile` queues any more than it covers the stuck-session ones.

## Known follow-up

`reconcile()` is a retained, deliberate exception to "these three modules never read `identity`'s tables directly" — it does exactly that, once per projection, confined to one named call site instead of scattered across every request. That's the correct trade for this phase, but it means a genuine future physical relocation of `KycEligibility` (a different database, not just a different schema in the same one) would need `reconcile()` itself reworked into an internal API call against the KYC service instead of a Prisma read — worth remembering as the one piece of this design still coupled to `KycEligibility`'s current, same-instance-different-schema location.
