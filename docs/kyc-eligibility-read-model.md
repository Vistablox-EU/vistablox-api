# KYC eligibility read model (design, not built)

This document is not a description of running code. It exists so that if `identity`'s `KycEligibility` table ever physically relocates — to its own schema on a different instance, or a genuinely separate database — the read side for its three external consumers (origination, offering, investor-profile) doesn't need to be designed under deadline pressure at cutover time. Nothing here is implemented, and nothing here should be, until that relocation is an actual, scheduled piece of work. Until then, [`kyc-eligibility-reader.ts`](../src/modules/identity/repository/kyc-eligibility-reader.ts)'s Prisma-backed implementation — an in-process, always-consistent, zero-latency read of the same table these three modules already share with `identity` — remains strictly better than anything below, on every axis that matters today.

## Why event-driven, if and when it's needed

Two things already true about this codebase make the choice easy once it's actually needed, and both are worth restating so a future implementer doesn't have to re-derive them:

`CreateReservationService` — the one consumer with money on the line — reads eligibility once via `getInvestorDetail`, outside any transaction, and never re-checks it. `computeReservationBlockers`'s own comment in [`reservation-eligibility.policy.ts`](../src/modules/offering/domain/reservation-eligibility.policy.ts) says the read is "advisory only, never a substitute for the atomic check at write time" — but the atomic, transactionally-locked recheck that actually exists at write time (`AD-146`) is capacity, not KYC. So the consistency bar this system already accepts for eligibility, even in today's single-database monolith, is "recent," not "read-your-writes." A subscriber-side read model that's seconds behind doesn't cross a line nothing already crosses.

`KycEligibility` writes are already asynchronous end-to-end: Didit's webhook durably enqueues via pg-boss, a worker (as of the webhook-extraction phase, the standalone `kyc-server.ts` process) processes it later, and only then does the row change. There is no synchronous read-after-write guarantee for eligibility today, even in-process. An event-driven local cache adds one more hop of a kind of staleness this system already has, rather than introducing a new category of it.

The alternative — a synchronous call from each of the three consumers to wherever `identity` ends up living — would newly couple `getInvestorDetail` (an offering-detail page view) and investor-profile's `get` (a dashboard read) to that service's uptime, not just the reservation path. An outage in a KYC-adjacent service would degrade three unrelated read APIs instead of leaving some rows briefly stale. For a financial platform, that broader blast radius is the worse trade.

## The mechanism

Confirmed against this repo's actual `pg-boss` version (`12.29.0`, `package.json`): `PgBoss` has a real publish/subscribe primitive, not something to build from queues by hand.

- `boss.subscribe(event: string, queueName: string)` maps a queue to an event topic. Its SQL is `INSERT ... ON CONFLICT (event, name) DO UPDATE` (`node_modules/pg-boss/dist/plans.js`) — idempotent, safe to call on every process start, the same convention `createQueue`'s `ON CONFLICT DO NOTHING` already establishes throughout this codebase.
- `boss.publish(event: string, data?: object, options?: SendOptions)` looks up every queue subscribed to `event` and calls `this.send(name, data, options)` for each (`node_modules/pg-boss/dist/manager.js`). Because it forwards the same `options` to `send()`, it is transactionally compatible with the existing `enqueueTransactionalJob` helper's pattern ([`enqueue-job.ts`](../src/shared/jobs/enqueue-job.ts)): a `publishTransactionalEvent(boss, transaction, eventName, data, traceId)` sibling function, binding the publish to the caller's own Prisma transaction via the same `db: { executeSql }` adapter, is a thin, consistent addition to that file — not a new pattern to introduce.
- One caveat worth knowing going in: `publish()`'s lookup of *which* queues are subscribed runs on pg-boss's own connection, not the caller's transaction — only the actual per-queue `send()` is transaction-bound. That's irrelevant here (subscriptions are fixed, ops-level configuration set once at deploy time, not something that changes mid-transaction), but it's a real asymmetry worth knowing about the primitive before relying on it elsewhere.

## Event contract

Topic: `identity.kyc_eligibility_changed`. Payload: the full [`KycEligibilitySnapshot`](../src/modules/identity/repository/kyc-eligibility-reader.ts) shape, not a bare "something changed, go re-fetch" notification — a subscriber must never need to call back into `identity` to resolve an event, or the whole point of decoupling the read path is lost.

Published unconditionally from every method on `PrismaKycRepository` that mutates a `KycEligibility` row: `reserveSessionStart`, `completeSessionStart`, `failSessionStart`, `reserveProofOfAddressSessionStart`, `completeProofOfAddressSessionStart`, `failProofOfAddressSessionStart`, `applyProviderOutcome`, `applyProofOfAddressOutcome`, `transitionToRequiresRenewal` — nine call sites as of this writing. Deliberately unconditional rather than diffing which specific fields changed per method: publishing is cheap and low-frequency here (KYC state changes are not a hot path), and an unconditional rule can't silently go stale the way a hand-maintained "does this method touch a snapshot-relevant field" list would the first time a consumer starts caring about a field nobody thought to check for.

## Consumer shape

Each of origination, offering, and investor-profile keeps a small local projection table mirroring `KycEligibilitySnapshot`, plus a subscriber job that applies incoming `identity.kyc_eligibility_changed` events to it. `KycEligibilityReader`'s implementation swaps from the current Prisma-backed one to one reading the local projection — and that's the entire blast radius on the consumer side. `getIntakePrerequisites`, `getInvestorDetail`, and investor-profile's `get` don't change at all, because Phase 1's port was already implementation-agnostic about where `getEligibilitySnapshot` reads from.

One open question, left open deliberately rather than settled here: investor-profile has no dedicated Postgres schema today — it reads across `account`/`offering`/`origination` through one shared Prisma client (`prisma-investor-profile.repository.ts`). Its projection table needs a schema home; `account` is the closest existing affinity, but that's a call for whoever actually builds this, made with whatever the schema topology looks like at that time.

## What a real build must not skip

**Cold-start backfill.** A freshly created projection table starts empty. "Wait for the next event per account" leaves every account with no recent KYC activity silently absent (read as `null`, i.e. `not_started`) until it happens to have one. A real implementation needs a one-time full sync from `identity`'s table into each new projection before the subscriber goes live, not just event-driven fill-as-you-go.

**A staleness backstop.** A subscriber that falls behind (crashed, backed up, redeployed mid-stream) should self-heal — a periodic reconcile pass, or at minimum surfaced lag past some threshold — rather than silently serving arbitrarily old data forever with no signal that anything is wrong. `AD-089`'s existing alert-source scoping doesn't cover a hypothetical queue like this any more than it covers the KYC stuck-session reconciliation jobs today ([`didit-kyc.md`](didit-kyc.md)'s own Follow-on work section already flags that same gap) — extending it, or building something bespoke, is part of the real build, not an afterthought.

## Status

Design only. No code, no migrations, no new queues exist because of this document. It becomes load-bearing the moment there's an actual, scheduled plan to relocate `KycEligibility` out of reach of a direct Prisma query from the three modules above — not before.
