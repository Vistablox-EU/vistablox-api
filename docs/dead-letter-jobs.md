# Dead-lettered jobs: alerts and replay

What happens when a background job exhausts its retries, how a person hears about it, and how to replay it safely. This page is for whoever receives the alert. Background on the retry profiles is in the README ("job retries and dead-lettering").

## What happens

A job that fails on every attempt is moved by pg-boss to the `maintenance.dead_letter` queue. Event jobs get there after 16 retries over about 3 hours; scheduled (cron) jobs after 5 quick retries. The worker consumes that queue and, for each entry:

1. Logs one `error` line, always, with `"event":"job.dead_lettered"` and the message `job dead-lettered after exhausting retries`.
2. If `DEAD_LETTER_ALERT_WEBHOOK_URL` is set, POSTs an alert to that URL. A failed or slow delivery (5 s timeout) logs a `warn` line with `"event":"job.dead_letter_alert_delivery_failed"` and is not retried; the worker carries on, and the error line from step 1 is still there.

Delivery is at least once: pg-boss completes the entry after the handler returns, so a worker crash in between sends the alert again. The dead-letter entry, with the job's payload, is kept for 30 days.

## The alert

The webhook receives a JSON POST that a Slack incoming webhook accepts as is (Slack reads `text` and ignores the rest). Any other receiver can read the `dead_letter` object:

```json
{
  "text": "[tier_1] Job dead-lettered: settlement.open_ipo_escrow_campaign (owner: settlement)\n...",
  "dead_letter": {
    "job": "settlement.open_ipo_escrow_campaign",
    "job_id": "<source job id>",
    "dead_letter_job_id": "<id to replay with>",
    "trace_id": "req_...",
    "owner": "settlement",
    "tier": "tier_1",
    "replayable": true,
    "attempts": 17,
    "last_error": "execution reverted"
  }
}
```

The job's payload is never sent: it can hold personal data. `last_error` is cut to 500 characters, and URLs, email addresses and long hex values (keys, hashes, addresses) are masked. The webhook URL itself is a secret (a Slack URL is its own credential) and is never logged.

### Configuring it

Set `DEAD_LETTER_ALERT_WEBHOOK_URL` in the worker's environment (`.env.staging` on staging; `docker-compose.staging.yml` passes it through). Unset or blank turns delivery off. It must be `https://` when `NODE_ENV=production` (which includes staging); plain `http://` is accepted only in development and tests, for a local receiver. The worker reads it at start, so restart the worker after changing it.

One URL receives every alert. Routing per owner (different channels for settlement and identity, say) is not built; a receiver can route on `dead_letter.owner` or `dead_letter.tier`.

## Ownership

Every queue has an owner and a tier in `src/shared/jobs/job-ownership.ts` (a test fails if a queue is created without one). A queue missing from the registry is reported as owner `platform`, `tier_1`. Following `AD-090`, anything that touches the settlement schema, money or account security is `tier_1`.

The mapping below is a proposal, **pending confirmation by the founder**: who the person behind each owner is, and whether each tier is right, are open.

| Queue | Kind | Owner | Tier |
| --- | --- | --- | --- |
| `settlement.open_ipo_escrow_campaign` | event | settlement | tier_1 |
| `settlement.finalize_ipo_escrow_campaigns` | scheduled | settlement | tier_1 |
| `settlement.confirm_wallet_registrations` | scheduled | settlement | tier_1 |
| `settlement.check_wallet_registry_health` | scheduled | settlement | tier_1 |
| `rental.operating_distribution_sweep` | scheduled | settlement | tier_1 |
| `case_timers.reservation_unfunded_expiry` | scheduled | payments | tier_1 |
| `case_timers.reservation_onramp_poll` | scheduled | payments | tier_1 |
| `case_timers.offering_reconfirmation_window_opened` | event | offering | tier_1 |
| `case_timers.offering_reconfirmation_window_close` | scheduled | offering | tier_1 |
| `case_timers.offering_reconfirmation_reminders` | scheduled | offering | tier_2 |
| `case_timers.pre_offering_open_handoff` | event | offering | tier_2 |
| `case_timers.post_ipo_structuring_handoff` | event | intake | tier_2 |
| `case_timers.applicant_reminders` | scheduled | intake | tier_2 |
| `case_timers.response_window_expiry` | scheduled | intake | tier_2 |
| `provider_events.coinbase_onramp_webhook` | event | payments | tier_1 |
| `provider_events.didit_webhook` | event | identity | tier_1 |
| `maintenance.account_recovery_alert` | scheduled | identity | tier_1 |
| `maintenance.wallet_registration_expiry` | scheduled | settlement | tier_1 |
| `maintenance.onramp_late_evidence_alert` | scheduled | payments | tier_1 |
| `maintenance.kyc_renewal` | scheduled | identity | tier_2 |
| `maintenance.kyc_stuck_session_expiry` | scheduled | identity | tier_2 |
| `maintenance.kyc_stuck_session_reconciliation` | scheduled | identity | tier_2 |
| `maintenance.dpop_replay_prune` | scheduled | platform | tier_2 |
| `maintenance.device_challenge_prune` | scheduled | platform | tier_2 |
| `maintenance.signing_request_prune` | scheduled | platform | tier_2 |

`AD-089`: there is no on-call rotation in phase 1, so tiers say how soon to look, not who is paged. Proposed: `tier_1` is triaged the same business day, `tier_2` becomes a ticket.

## Triage

1. Find the worker log lines for the job. `trace_id` ties the job to the request that enqueued it:

       docker compose --env-file .env.staging -f docker-compose.staging.yml logs --no-log-prefix --since 6h worker | grep '"job.dead_lettered"'
       docker compose --env-file .env.staging -f docker-compose.staging.yml logs --no-log-prefix --since 6h worker | grep '<trace_id>'

2. Decide why it failed. A dependency that was down (RPC, Didit, SMTP, the database) is worth a replay once it is back. A payload or state the handler cannot accept will fail again; fix the data or the code first, or decide the job should not run at all.
3. A **scheduled** job (`replayable: false`) is not replayed: its next tick re-runs the same work. Fix the cause and watch the next run succeed. A repeated alert for the same scheduled `job` every tick means the cause is still there.
4. An **event** job (`replayable: true`) runs only once, so its work will not happen until it is replayed.

## Replay

The replay command sends the dead-lettered payload, unchanged, back to the queue it failed on, as a new job with the normal event retry profile. It runs inside the worker container, which has the database URL:

    docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker npm run jobs:replay-dead-letter -- --dead-letter-job-id <dead_letter_job_id>

Without `--confirm` this is a **dry run**: it prints the queue, the owner and tier, the source job id, the attempt count, the payload's key names (never its values) and the id the replay will get, and changes nothing. Check that it is the job you expect, then send it:

    docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker npm run jobs:replay-dead-letter -- --dead-letter-job-id <dead_letter_job_id> --confirm

The replay logs `"event":"job.dead_letter_replayed"` with both ids. Then watch the job's queue in the worker log until it succeeds. If it fails again it is retried for another 3 hours and, failing that, dead-letters again with a new `dead_letter_job_id`.

Exit codes: `0` done (or dry run), `1` refused or failed, `2` bad arguments.

### What makes it safe

- Only event queues are replayed. The command refuses scheduled queues, queues missing from the ownership registry, and entries with no source queue.
- Each entry can be replayed once. The replayed job's id is derived from the dead-letter entry's id, so a second run (or two people running it at once) is refused, or sends nothing. The replayed job is kept for 30 days (the dead-letter entry's own retention), so the guard lasts as long as the entry can be replayed.
- Every event consumer already has to be safe to run up to 17 times (the README's retry section), so one more run is within that contract. The known exceptions are the retry hazards the README lists, and they apply to a replay too:
  - `settlement.open_ipo_escrow_campaign`: check on-chain whether the campaign is already open (or a transaction is still pending) before replaying, or the replay can broadcast another `openCampaign` and waste gas.
  - `case_timers.offering_reconfirmation_window_opened`: if the email went out and only the audit write failed, a replay sends the email again. It also does not re-check that the reservation still awaits reconfirmation.
  - `case_timers.pre_offering_open_handoff`: it does not re-check the case stage. Confirm the case is still `pre_offering_open` before replaying, or the replay opens the offering anyway.
  - `case_timers.post_ipo_structuring_handoff`: fails for good for a case outside its expected stages; replaying without fixing the case only dead-letters it again.
  - `provider_events.didit_webhook`: skips an event it has already recorded, so a replay is harmless.
  - `provider_events.coinbase_onramp_webhook`: re-fetches the reservation's transactions from Coinbase and records an outcome only once per provider transaction and state, so a replay is harmless.

### Finding entries without the alert

Entries are rows in the pg-boss `job` table. Recent ones, newest first (read only):

    SELECT id AS dead_letter_job_id, source_name, source_id, state, created_on
      FROM pgboss.job
     WHERE name = 'maintenance.dead_letter'
     ORDER BY created_on DESC
     LIMIT 20;

An entry is kept for 30 days after it lands; after that it cannot be replayed.
