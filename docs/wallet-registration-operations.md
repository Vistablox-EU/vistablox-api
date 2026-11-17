# Wallet registration: operating the watcher

How to run, watch and repair the part of wallet onboarding that happens after the investor signs: the worker's `settlement.confirm_wallet_registrations` job (the watcher) and the `settlement.check_wallet_registry_health` job that watches it. For what the flow is, see [`investor-profile.md`](investor-profile.md) (AD-241). This page is for whoever is looking at the worker's log or at a stuck investor.

## What is built, and what is not

Built: the watcher reports its health as structured log events with stable names, thresholds are configurable, and this page says what each event means and what to do.

**Not built: delivery.** Nothing sends these events to a person. `AD-089` records Slack or email webhooks as the phase-1 alert channel and `AD-088` records host logs read by hand as the log pipeline; no log shipper exists in this repository yet, and the only webhook sender is the one for dead-lettered jobs ([`dead-letter-jobs.md`](dead-letter-jobs.md)), which does not carry these events. Until one does, an event reaches someone only if they read the worker log. The grep commands below are the interim way. When a delivery mechanism is chosen it should key on the `event` and `severity` fields described here, throttle repeats (the health events repeat every 5 minutes while a condition holds) and add an "absent" rule on `wallet_registry.health_checked`.

## Ownership

`AD-089`: no on-call rotation in phase 1; an alert helps only if someone is looking. `AD-090`: anything touching the `settlement` schema or account security is a Tier 1 incident.

Proposed mapping, **pending confirmation by the founder** (who the named owner is, and whether this tiering is right, are open):

| Severity | Meaning | Handling |
| --- | --- | --- |
| `error` | The watcher is not working, or a registration was attempted from the wrong address | Tier 1: triage the same business day |
| `warn` | A claim or event needs a look, nothing is down | Tier 2: a ticket |
| `info` | Proof of life | Nothing to do |

## How the watcher works, briefly

Every minute the watcher reads the registry contract's `WalletRegistered` events, starting 31 blocks before its saved cursor (so it re-reads the last 32 blocks) and ending three blocks behind the chain head, at most 2000 blocks per run. It matches each event to a live claim (pending, and not expired) by commitment, compares the sender with the stored wallet address, and either confirms the claim or records an address mismatch. After a completed run it saves the cursor and writes a heartbeat (`platform.settings`, key `wallet_registry.watcher_heartbeat`: when the run completed, the cursor, and the safe head it saw).

Every 5 minutes the health check reads the heartbeat, the pending claims and the open mismatches **from the database only**. It makes no RPC call, so it still reports when the RPC provider is the thing that is down. Because the watcher re-reads its last 32 blocks every minute, anything it reports about an event is de-duplicated: an address mismatch is announced once per (account, commitment, sender).

## Events

Every line carries `event`, `severity`, `job` and `trace_id`. Rules should key on `event` and `severity`, not on the message text or pino's numeric `level`.

| Event | Severity | Fields | Meaning and first response |
| --- | --- | --- | --- |
| `wallet_registry.address_mismatch` | error | `account_id`, `commitment_masked`, `stored_wallet_masked`, `on_chain_sender_masked` (or `listed_limit` on the one line that says the rest of a run's mismatches, beyond the first 20, are not listed; every one is still counted) | An event named this account's commitment but was sent from a different address than the one on file: a spoofing attempt, or an investor who registered from another wallet. The claim stays pending. Look the account up (see Reconciliation) and **do not reconcile it with the sender's transaction**, which cannot match by construction. Main has no way to change the address of a pending claim; do not edit rows by hand, escalate to engineering. Announced once, as soon as it is recorded, even if that run then fails; `address_mismatch_unresolved` reminds you while it stays open. |
| `wallet_registry.watcher_stalled` | error | `reason` (`heartbeat_stale` or `no_completed_run_since_start`), `age_seconds`, `stale_after_seconds` | No completed watcher run for the threshold. Check the worker container is up, then the `watcher_failed` and `heartbeat_write_failed` lines just before it (an RPC outage, a wrong `CHAIN_RPC_URL`, a database that will not take writes). A restart gives the worker one full threshold before it can be called stalled again. |
| `wallet_registry.cursor_lag` | error | `lag_blocks`, `threshold_blocks`, `cursor_block`, `safe_head_block` | The saved cursor is far behind the safe head as of the last run. A run catches up at most 2000 blocks, so after an outage longer than about 100 minutes (2000 blocks plus the 900-block threshold, at 2 seconds a block) this shows for a few minutes while the watcher catches up, then clears itself. If it persists while the heartbeat is fresh, the RPC is failing or slow; look at `watcher_failed`. |
| `wallet_registry.cursor_ahead_of_chain` | error | `ahead_blocks`, `tolerance_blocks`, `cursor_block`, `safe_head_block` | The cursor is more than 32 blocks past what the RPC says the head is: the RPC points at a lagging node or the wrong chain, or someone raised the cursor. The watcher reads nothing while this holds. Check `CHAIN_NETWORK` against `CHAIN_RPC_URL` before touching the cursor. |
| `wallet_registry.watcher_not_configured` | error with pending claims, warn without | `pending_total` | The registry address is set (claims are being created) but the `CHAIN_*` settings the watcher also needs are not, so no watcher runs and no claim can confirm. Fix the configuration. |
| `wallet_registry.health_check_failed` | error | `error_name`, `error_message`, `error_stack` | The health check could not run, usually because the database is unreachable from the worker. |
| `wallet_registry.watcher_failed` | warn | `error_name`, `error_message`, `error_stack` | One watcher run failed (an RPC blip is routine) and is retried within a minute. Look only if it repeats; persistent failure becomes `watcher_stalled`. The error text has URLs replaced by `[url]` and long hex values masked. |
| `wallet_registry.heartbeat_write_failed` | warn | `error_name`, `error_message` | The run completed but its heartbeat could not be written; expect `watcher_stalled` to follow if it continues. |
| `wallet_registry.pending_overdue` | warn | `pending_registrations_overdue`, `pending_total`, `threshold_count`, `oldest_pending_age_seconds` | Claims have been pending past `WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES`. Usually an investor who never signed; a support item. If the watcher alerts above are quiet, the platform is not at fault. If a signed registration is stuck, see Reconciliation. |
| `wallet_registry.unmatched_events` | warn | `new_unmatched_events`, `threshold_count` | A single run saw this many registry events in new blocks whose commitment matches no live registration row: another app registering, a commitment this database never issued, a claim the account has since replaced, or a claim that **expired** (a late event for an expired claim is counted here, not as stale: `AD-287`, decided 2026-11-17). A slow trickle does not raise it; use the counter below. For an investor who signed late, see Reconciliation. |
| `wallet_registry.address_mismatch_unresolved` | warn | `unresolved_count`, `account_ids` (at most 20) | A recorded mismatch whose account's current claim is still unconfirmed and still has that commitment. Repeats every 5 minutes until the claim is confirmed or replaced. |
| `wallet_registry.health_checked` | info | `watcher_configured`, `heartbeat_age_seconds`, `cursor_block`, `safe_head_block`, `cursor_lag_blocks`, `pending_total`, `pending_overdue`, `unresolved_address_mismatches`, `alerts_active` | Proof of life, every 5 minutes. If this line stops appearing the check or the whole worker has stopped. |

Health events are level-triggered: they repeat every 5 minutes while the condition holds. An address mismatch and a failed run are announced when they happen. A mismatch is announced from the moment it is recorded, not when its run completes, so a run that fails afterwards still shows it (before that run's `watcher_failed` line); the retry reads the event again and says nothing.

## Thresholds

Starting values for Base Sepolia, not calibrated against real traffic (`AD-234` keeps mainnet dormant); revisit them before activation. Set them in `.env.staging`; blank means the default. `docker-compose.staging.yml` passes each through the `&app-environment` anchor.

| Variable | Default | Bounds | Drives |
| --- | --- | --- | --- |
| `WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES` | 5 | 1-1440 | How old a pending claim must be to count as overdue |
| `WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT` | 1 | 1-10000 | `pending_overdue`: overdue claims needed |
| `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES` | 10 | 2-1440 | `watcher_stalled`: minutes without a completed run |
| `WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS` | 900 | 1-1000000 | `cursor_lag`: about 30 minutes at Base's 2 second blocks |
| `WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT` | 5 | 1-10000 | `unmatched_events`: new unmatched events in one run |
| `WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS` | 24 | 1-720 | How old a pending claim must be before `maintenance.wallet_registration_expiry` expires it (see below) |
| `WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES` | 15 | 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60 | Minutes between expiry sweeps; only a divisor of 60, so the runs are evenly spaced |
| `WALLET_REGISTRY_PENDING_EXPIRE_BATCH_SIZE` | 500 | 1-5000 | The most claims one sweep expires, oldest first |

The cursor-ahead tolerance is not a setting: it is the watcher's own 32-block overlap. The expiry sweep has no thresholds of its own for the watcher: it reuses `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES` and `WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS` (and that tolerance).

## Expiry of pending claims

`AD-287` (decided 2026-11-17): a pending claim expires. Every `WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES` (15 by default, UTC) the worker's `maintenance.wallet_registration_expiry` job marks every claim still pending after `WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS` (24 by default) as expired: it sets `expired_at` on the row, keeps the row and its address and commitment, and writes an audit row `settlement.wallet_registration_expired` (resource type `account`, no actor, with the wallet address, commitment and `requested_at`). A claim is expired once it is that old: one requested exactly the lifetime ago has expired, one a millisecond younger has not. A run expires at most `WALLET_REGISTRY_PENDING_EXPIRE_BATCH_SIZE` (500) claims, oldest first; the next run takes the rest. It logs the usual `maintenance job completed` line with `checked` (claims past the cutoff when the run started) and `acted` (claims it expired). A confirmed claim is never expired, and the database refuses `expired_at` on one. Nothing deletes an expired row: it stays for the staff view, the audit trail and the reconcile below. How long expired rows are kept is not decided.

**The sweep does nothing while the watcher cannot be trusted.** A claim whose registration event the watcher has not read yet is not abandoned. Before it expires anything the sweep reads the same health snapshot as `settlement.check_wallet_registry_health`, applies the same policy with the same thresholds, and skips the run if the watcher is stale (`wallet_registry.watcher_stalled`: no completed run for `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES`, or no readable heartbeat at all), its cursor lags (`wallet_registry.cursor_lag`), or its cursor is ahead of the chain (`wallet_registry.cursor_ahead_of_chain`), or it has run before and cannot run now (`wallet_registry.watcher_not_configured`, below). Unlike the health check it gives a restarted worker no grace period: only the recorded heartbeat counts, so a deploy during an outage does not let the first sweep expire claims the watcher never read. If the snapshot cannot be read (the database is unreachable), the sweep skips too. A skipped run expires nothing, reports `checked: 0, acted: 0`, and writes one line, which is not one of the `wallet_registry.*` alerts:

| Event | Level | Fields | Meaning |
| --- | --- | --- | --- |
| `wallet_registration_expiry.skipped` | info | `job`, `trace_id`, `reasons` (the `wallet_registry.*` event names above) | The watcher is stale, lagging, or has stopped for lack of configuration; the claims wait. Fix the watcher (its own alerts say what is wrong); the first sweep after it recovers catches up. |
| `wallet_registration_expiry.skipped` | warn | `job`, `trace_id`, `reasons: ["health_unreadable"]`, `err` | The health snapshot could not be read. Look at the database connection. |

    docker compose --env-file .env.staging -f docker-compose.staging.yml logs --no-log-prefix --since 1h worker | grep '"event":"wallet_registration_expiry\.skipped"'

**A watcher that cannot run is judged by whether it ever ran.** There are three cases where no watcher runs in the worker:

- **The registry address is unset.** The registry is switched off in this worker: the health check does not exist either, nobody is waiting on a watcher, and the sweep runs whatever rows the database holds. (If the address was dropped by mistake, restore it and the next sweep is gated again.)
- **The address is set but the `CHAIN_*` settings are missing, and the watcher has run before.** This is a worker that lost its `CHAIN_*` settings (configuration drift) and is the state the health check calls `wallet_registry.watcher_not_configured`, "pending claims cannot confirm". The watcher keeps its saved cursor (`platform.settings`, key `wallet_registry.last_processed_block`) and its last heartbeat, so the day the settings are back it reads every event it missed. A claim expired in the meantime would see its event counted as unmatched, and the investor would need a staff reconcile or a second signature. So the sweep waits, however old or fresh the last heartbeat is, and logs `reasons: ["wallet_registry.watcher_not_configured"]`. "Has run before" means any row at all: a heartbeat (even one that cannot be read) or a saved cursor.
- **The address is set, the `CHAIN_*` settings are missing, and the watcher never ran** (no heartbeat row and no cursor). There is no event it could be about to read, so nothing holds the sweep back. Claims created in this state can never confirm, and they expire like any other.

The way out of the second case is to restore the `CHAIN_*` settings; the watcher resumes from its cursor, catches up (see `wallet_registry.cursor_lag`), and the sweep follows once the heartbeat is fresh. Deleting the watcher's rows to unblock the sweep would discard the cursor and is not a fix.

Once expired, a claim:

- reads as no wallet to the customer: `GET /v1/investor-profile/wallet` answers `404 wallet.not_registered`, the investor profile shows `wallet.status: "not_registered"` with `payment_account_ready` false, and the offering readiness is unchanged (it only ever counted a confirmed registration);
- reads as `status: "expired"` with `expired_at` in `GET /internal/v1/wallet-accounts/:account_id`;
- leaves the pending counts, `pending_overdue` and the unresolved-mismatch reading;
- is no longer matched by the watcher: a `WalletRegistered` event naming its commitment is counted as **unmatched** (`unmatchedEvents` in the run summary and `unmatched_events_total`; in a new block it also counts toward `new_unmatched_events_total` and, past `WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT` in one run, the `wallet_registry.unmatched_events` warning), never as stale, and confirms nothing. That includes an event that arrives in the moment between the watcher matching the claim and the sweep expiring it;
- **can be reconciled by staff** on matching on-chain evidence (see Reconciliation), which confirms it.

The investor registers again from the app. If the address differs from the expired one that needs **fresh authentication**, exactly like replacing a live pending claim (`AD-287`, consistent with `AD-279`'s second decision item): without it the request is refused with `403 authentication.fresh_auth_required` and nothing is written. Submitting the same address again needs only the ordinary session. Either way a new commitment is issued (the expired one is never handed out again), and the registration is audited as `settlement.wallet_registration_requested` with `previous_expired_wallet_address`. The registry contract accepts repeated `register()` calls, so an investor who signed late signs once more, unless staff reconcile the late signature first. Do not clear `expired_at` by hand to revive a claim: reconcile it.

## Reading the log

The worker writes JSON lines to stdout. Run these from the project directory on the staging host, where `.env.staging` and `docker-compose.staging.yml` are. Compose reads the whole compose file for every subcommand, and that file requires `POSTGRES_PASSWORD` and the MinIO keys, so each command passes `--env-file .env.staging`, as `scripts/deploy/staging.sh` does; without it compose stops with "required variable ... is missing a value". Show the events from the last hour, errors first:

    docker compose --env-file .env.staging -f docker-compose.staging.yml logs --no-log-prefix --since 1h worker | grep '"event":"wallet_registry\.'
    docker compose --env-file .env.staging -f docker-compose.staging.yml logs --no-log-prefix --since 1h worker | grep '"event":"wallet_registry\.' | grep '"severity":"error"'

A job that exhausted its retries also logs `job dead-lettered after exhausting retries` (`"event":"job.dead_lettered"`) with the job name and a `last_error` that has URLs replaced by `[url]`. Unlike the events above, dead-lettered jobs are delivered to a person when `DEAD_LETTER_ALERT_WEBHOOK_URL` is set; see [`dead-letter-jobs.md`](dead-letter-jobs.md) for the alert and the replay runbook.

## Metrics

The worker serves Prometheus text on loopback port 3001 inside its container (not published). Read it with:

    docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker node -e "fetch('http://127.0.0.1:3001/metrics').then(r=>r.text()).then(console.log)" | grep wallet_registration

Counters (process-local, reset when the worker restarts) are prefixed `vistablox_worker_wallet_registration_`: `runs_total`, `failures_total`, `confirmed_total`, `unmatched_events_total` (every event whose commitment matches no live registration row: none at all, a claim the account replaced, or an expired claim; the overlap rescan of a registration that is already confirmed is a replay, counted as `eventsReplayed` in the run summary, and is not an unmatched event), `new_unmatched_events_total` (only events in new blocks; the one to rate), `address_mismatches_total` (first-seen only), `address_mismatch_duplicates_total`, `heartbeat_write_failures_total`, `health_check_failures_total`. Gauges set by the health check: `pending_total`, `pending_overdue`, `watcher_heartbeat_age_seconds` (-1 means no heartbeat yet), `cursor_lag_blocks` (negative when the cursor is ahead), `address_mismatch_unresolved`, `health_alerts_active`.

A dead worker container is not reported by any of this: the log goes silent. The container's own health check (`/health/ready` on loopback port 3001) and `restart: unless-stopped` cover that.

## What may appear in a log, a ticket or chat

Identifiers only: `account_id`, masked values such as `0xabcd...ef01` (first six and last four characters; enough to tell two apart, not enough to look one up), block numbers as decimal strings. **Do not paste a full wallet address or commitment into chat or a ticket**; use the `account_id`. The audit row (`audit.audit_log`, action `settlement.wallet_registration_address_mismatch`) and the staff endpoint below hold the full values, because a reviewer needs them; treat them as personal data.

## Reconciliation: a registration the watcher missed

Use this when an investor has signed but the claim is still pending and the watcher is healthy, or after a watcher outage. Staff only (`admin_operations` plus a staff WebAuthn session).

1. Take the `account_id` from the log line. Do not start from an address.
2. `GET /internal/v1/wallet-accounts/:account_id` returns `status` (`pending`, `registered` or `expired`), `requested_at`, `expired_at` and, for staff, the stored `wallet_address` and `registration_commitment`. If `status` is already `registered`, the reconcile can only fill in or replace the recorded chain evidence (`registration_evidence` in the same response shows what is recorded and whether it is flagged); it never changes `registered_at`. If it is `expired`, the investor's claim timed out; a `wallet_registry.unmatched_events` warning is often how a late signature shows up, and reconciling it below confirms the claim.
3. On the chain explorer, open the registry contract's events and filter `WalletRegistered` by the commitment (both `wallet` and `commitment` are indexed). Find the transaction whose `wallet` is the stored wallet address.
4. `POST /internal/v1/wallet-accounts/:account_id/reconcile` with `{"transaction_hash": "<that transaction>"}`. The route exists only where `CHAIN_NETWORK`, `CHAIN_RPC_URL` and the registry address are all set.

The server checks the transaction itself: its receipt must be successful, the chain head at least three blocks past it, and it must contain a `WalletRegistered` log whose wallet **and** commitment both match the stored ones. On success a pending claim is confirmed together with the identity of the event (transaction hash, block hash and number, log index), and an audit row `settlement.wallet_registration_reconciled` is written with your account as the actor. An **expired** claim is confirmed the same way (`AD-287`): the confirmation clears `expired_at` in the same write, the response says `outcome: "confirmed"`, and the audit row carries `reinstated_from_expired_at` with the time of the expiry it undid; the expiry's own audit row stays as history. The same uniqueness rules apply as for any confirmation: another account's confirmed registration of the address (`409 wallet.address_already_claimed`) or another account's registration backed by the same on-chain event (`409 wallet.registration_event_already_used`) refuses it and leaves the claim expired. If the investor registered again in the meantime the claim now has a new commitment, so nothing is written and the call answers `409 wallet.registration_changed`. The write is a compare-and-set on the address and commitment the row held when it was read: if the customer replaced the pending claim in the meantime nothing is written and the call answers `409 wallet.registration_changed` (read the registration again and retry), and if another account already holds the address confirmed it answers `409 wallet.address_already_claimed` and records the conflict in the audit log with your account as the actor. Evidence filled in or replaced on a claim that is already registered is audited, with your account as the actor, as `settlement.wallet_registration_evidence_recorded` or `settlement.wallet_registration_evidence_replaced`.

A failed check answers a specific code: `422 wallet.registration_transaction_not_found`, `wallet.registration_transaction_reverted` or `wallet.registration_event_not_found`, `409 wallet.registration_transaction_unconfirmed` (retry in a minute), `503 wallet.chain_unavailable`. A transaction whose event already backs another account's registration answers `409 wallet.registration_event_already_used`, and a registration already confirmed by a different event (and not flagged) answers `409 wallet.registration_evidence_conflict`; neither changes anything.

Do not:

- reconcile an address-mismatch claim with the sender's transaction (it cannot pass, by design);
- run an `UPDATE` on `settlement.wallet_registrations` by hand;
- reconcile a claim that is already `registered` with a different transaction to "correct" it: the reconcile refuses a different event for a registration that is not flagged (`409 wallet.registration_evidence_conflict`) and replaces the evidence only of a flagged registration or of one whose transaction was mined again.

## Moving the cursor

Only an engineer, only as a break-glass step, and only ever **lower** it: to re-read blocks the watcher already passed (a provider that returned incomplete logs). Re-reading is safe: confirming an already-confirmed claim does nothing, and mismatches are de-duplicated. Raising the cursor skips events permanently, so do not. The row is `platform.settings` key `wallet_registry.last_processed_block`, and its value is a JSON string holding the decimal block number (for example `"1234567"`, quotes included). Record who changed it, from what to what, and why, in the incident note. A run re-reads at most 2000 blocks, so a large rewind takes several runs, and the events it re-reads in blocks past the new cursor can raise one `unmatched_events` warning.

## Rollback

Reverting this change needs no database step. The heartbeat row and the de-duplicated audit rows it adds are inert to the older code, and the cursor row's format is unchanged.

Reverting the expiry of pending claims (#177) is different: code that does not know `expired_at` would read an expired claim as pending again, and the watcher could confirm it on a late event, which `AD-287` (decided 2026-11-17) does not want while the feature is live but does no harm to the investor who signed. Nothing in the feature deletes an expired row, and rolling back should not either: leave the rows and the column in place (the older code ignores the column), and accept that an expired claim reads as pending again. Whether to wipe them first is an engineer's decision at that moment, with the audit rows as the record. The pg-boss schedule for `maintenance.wallet_registration_expiry` must be removed (`boss.unschedule`), or jobs pile up in a queue nothing works.
