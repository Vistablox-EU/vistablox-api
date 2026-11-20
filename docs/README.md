# VistaBlox API documentation

Valid for main at 48aa967 (2026-11-18).

This is the index and entry point of the documentation of `vistablox-api`: what the repository is, which document answers which question, how the documents are kept honest, the vocabulary the code uses, and the rules for changing the documents when the code changes. It is read first by every kind of reader: a developer who is new to the code, a developer who calls the API, an operator, and a reviewer or auditor. Open pull requests and known defects are collected in [status.md](status.md).

Contents: [1 What the API is](#1-what-vistablox-api-is) · [2 Reading guide](#2-reading-guide) · [3 All documents](#3-all-documents) · [4 How the documents are kept honest](#4-how-the-documents-are-kept-honest) · [5 Vocabulary](#5-vocabulary) · [6 Conventions for contributors](#6-conventions-for-contributors)

## 1. What vistablox-api is

`vistablox-api` is the API-only backend of VistaBlox: it has no user interface of its own and is built from Express, TypeScript, Zod, Prisma, PostgreSQL, a pg-boss worker and Better Auth (`AGENTS.md:3`, `README.md:3`). One codebase builds two long-running Node.js processes, the api (`src/server.ts`, Express 5.2.1) and the worker (`src/worker.ts`, pg-boss 12.29.0), plus operator commands under `src/cli`; all of them use one PostgreSQL database through Prisma 7.10.0 and Better Auth 1.7.2 runs inside the api process (`package.json:42`, `:46`, `:52`, `:38`; `package.json:10-18`). The api answers six kinds of path: `/v1` for customer apps, `/internal/v1` for staff and partners, `/api/auth` for Better Auth, `/health`, the provider callbacks `/webhooks/didit` and `/webhooks/coinbase-onramp`, and `/.well-known` (`src/app.ts:568-595`, `:908-935`; see [api/README.md](api/README.md#2-base-urls-and-prefixes)). The product code is eleven modules under `src/modules`, each layered as `api`, `application`, `domain` and `repository`, and a state change that crosses a domain goes through a pg-boss job queued in the caller's transaction (`AGENTS.md:17-18`; [architecture.md](architecture.md)). The platform takes a property from an owner's submission through staff review to an offering that investors reserve and fund, and the backend stores wallet addresses and reads balances but never holds or uses a user's key; several capabilities are built and switched off ([status.md](status.md#2-built-and-switched-off)).

The eleven modules are `account`, `auth`, `health`, `identity`, `intake`, `investor-activity`, `offering`, `profile`, `rental`, `settlement` and `wallet` (directory listing of `src/modules`); each has a chapter under [modules/](modules/).

## 2. Reading guide

| Reader | Read, in this order | Then |
| --- | --- | --- |
| New developer | The repository `README.md` and `AGENTS.md`; [architecture.md](architecture.md) (processes, layers, request lifecycle); the chapter of the module you will work in under [modules/](modules/); [data-model.md](data-model.md); [testing.md](testing.md) | [jobs-and-workers.md](jobs-and-workers.md) if you touch a queue; [cli.md](cli.md) for the commands; [security.md](security.md) before you add a route or a guard |
| Developer who calls the API (mobile app, admin console, partner client) | [api/README.md](api/README.md) (prefixes, headers, envelope, error codes, pagination, rate limits, idempotency); [authentication.md](authentication.md); the route chapter for your area (section 3) | [staff-access.md](staff-access.md) for the internal API; [status.md](status.md) for routes that an open pull request changes |
| Operator | [operations.md](operations.md) (images, compose files, deploy, migrations, health); [configuration.md](configuration.md) (every variable); [jobs-and-workers.md](jobs-and-workers.md); [cli.md](cli.md) | The runbooks: [dead-letter-jobs.md](dead-letter-jobs.md), [wallet-registration-operations.md](wallet-registration-operations.md), [escrow-mint-reconciliation.md](escrow-mint-reconciliation.md), [account-recovery.md](account-recovery.md); [integrations.md](integrations.md) for what fails when a dependency is down |
| Auditor or reviewer | [security.md](security.md) (controls and the 33 numbered defects); [authentication.md](authentication.md); [staff-access.md](staff-access.md); [data-model.md](data-model.md); [integrations.md](integrations.md) | [status.md](status.md) (limitations with risk, gaps against the design record, decisions awaiting the founder, what is not verified) |
| Founder | [status.md](status.md) | The chapter that an item of `status.md` links to |

## 3. All documents

Every file under `docs/`. The chapters marked "chapter" carry the line `Valid for main at 48aa967` and citations; the existing guides and plans were not rewritten and carry neither (section 4).

### 3.1 Start here and cross-cutting chapters

| Document | Kind | What it answers |
| --- | --- | --- |
| [README.md](README.md) | index | This page. |
| [status.md](status.md) | chapter | Open pull requests that change documented behaviour, what is switched off, known limitations with risk and issue, gaps against the design record, decisions awaiting the founder, what is not verified, how to update after a merge. |
| [architecture.md](architecture.md) | chapter | Processes and what each depends on, the layers, the composition root, the request lifecycle, the error envelope, cross-domain jobs, self-custody. |
| [security.md](security.md) | chapter | Every security control and where it sits in the code; the 33 numbered defects with risk; conflicts with the design record. |
| [authentication.md](authentication.md) | chapter | Customer sign-in: the Better Auth setup, device enrolment and login, DPoP proofs, sessions, fresh authentication, social sign-in, linking, device replacement, closure, signing requests. |
| [staff-access.md](staff-access.md) | chapter | The `staff_partner` population and its three roles, invitations, passkey sign-in, guards and their order, dual control, the role-by-route matrix. |
| [data-model.md](data-model.md) | chapter | Every schema, table, column, constraint and trigger, the enumerated values, retention, locks, and the 75 migrations. |
| [jobs-and-workers.md](jobs-and-workers.md) | chapter | The worker, pg-boss settings, every queue with producer, consumer, schedule and failure behaviour, the dead-letter path, the probe and metrics. |
| [cli.md](cli.md) | chapter | Every operator command and every `package.json` script: arguments, environment, effects, safety, exit codes. |
| [configuration.md](configuration.md) | chapter | Every environment variable: type, default, which process reads it, where a value is set in local, CI and staging. |
| [operations.md](operations.md) | chapter | Images, compose files, the pull request to staging path, migrations, health checks, logs and alerts, and what the repository does not say. |
| [integrations.md](integrations.md) | chapter | Every external system: the client, the calls, authentication, timeouts, retries, failure behaviour. |
| [testing.md](testing.md) | chapter | The `npm run check` gate, the Vitest suite and its isolation rules, integration suites, contract tests, CI workflows, and where a green run proves less than it appears to. |

### 3.2 API reference

| Document | Kind | Routes |
| --- | --- | --- |
| [api/README.md](api/README.md) | chapter | Conventions for every route: prefixes, content types, headers, error codes, pagination, rate limits, idempotency, and the configuration under which each route group exists. |
| [api/platform.md](api/platform.md) | chapter | Health and worker probes, `/.well-known/*`, account search, investor profile, investor activity, KYC and the Didit webhook. |
| [api/better-auth.md](api/better-auth.md) | chapter | `/api/auth/*`: which Better Auth endpoints are reachable, and the VistaBlox hooks in front of them. |
| [api/auth-customer.md](api/auth-customer.md) | chapter | `/v1/app/config` and `/v1/auth/*` for customers and devices. |
| [api/auth-staff.md](api/auth-staff.md) | chapter | `/internal/v1/auth/*`, staff invitation acceptance, customer account recovery and closure review. |
| [api/intake-customer.md](api/intake-customer.md) | chapter | `/v1/intake-cases/*`. |
| [api/intake-staff.md](api/intake-staff.md) | chapter | `/internal/v1/intake-cases/*`, the partner organisation registers, the partner case routes. |
| [api/offering.md](api/offering.md) | chapter | `/v1/offerings/*`, `/internal/v1/offerings/*`, `/webhooks/coinbase-onramp`. |
| [api/wallet.md](api/wallet.md) | chapter | `/v1/investor-profile/wallet*`, `/internal/v1/wallet-accounts/*`. |

### 3.3 Module chapters

| Document | Kind | Module |
| --- | --- | --- |
| [modules/account.md](modules/account.md) | chapter | The local account record, the Better Auth user mapping, staff-role questions, account search. |
| [modules/auth.md](modules/auth.md) | chapter | Sign-in, sessions, DPoP, fresh authentication, staff roster and invitations, recovery and closure. |
| [modules/health.md](modules/health.md) | chapter | The api liveness and readiness probes. |
| [modules/identity.md](modules/identity.md) | chapter | Individual KYC with Didit, proof of address, renewal and stuck-session timers. |
| [modules/intake.md](modules/intake.md) | chapter | The property origination pipeline from submission to the handoff to an offering. |
| [modules/investor-activity.md](modules/investor-activity.md) | chapter | The investor's reservation and position histories. |
| [modules/offering.md](modules/offering.md) | chapter | Offerings, reservations and their funding through Coinbase, reconfirmation, disclosure packs, materiality. |
| [modules/profile.md](modules/profile.md) | chapter | The investor profile aggregate and the notification and locale preferences. |
| [modules/rental.md](modules/rental.md) | chapter | Operating distributions: built and dormant. |
| [modules/settlement.md](modules/settlement.md) | chapter | The on-chain side: escrow campaigns, minting, the wallet registry watcher. |
| [modules/wallet.md](modules/wallet.md) | chapter | Wallet claims, balances, unsigned transfer preparation, staff reconciliation. |

### 3.4 Existing guides, plans and diagrams

These were written before the chapters and were not edited. Where a chapter found a statement in one of them that is out of date, the chapter says so. Issues #221, #222 and #223 on the issue tracker track stale statements in the README and in the runbooks for dead-letter replay, Didit alerting and the wallet registry.

| Document | Kind | What it covers |
| --- | --- | --- |
| [account-recovery.md](account-recovery.md) | guide | Customer full-lockout recovery: dual review, a fresh Didit check, the cooldown. Its completion step is out of date (see [api/auth-staff.md](api/auth-staff.md#customer-account-recovery-cases)). |
| [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) | guide | The Coinbase CDP buy-side REST surface behind reservation funding (AD-255). |
| [dead-letter-jobs.md](dead-letter-jobs.md) | runbook | What happens when a job exhausts its retries, the alert, how to replay safely. |
| [didit-kyc.md](didit-kyc.md) | guide | Didit individual KYC: sessions, webhooks, decisions, proof of address, renewal. |
| [document-storage.md](document-storage.md) | guide | Private document storage: buckets and API-proxied downloads. |
| [escrow-mint-reconciliation.md](escrow-mint-reconciliation.md) | runbook | What the escrow finalizer decides when it mints, and manual reconciliation. |
| [investor-offering.md](investor-offering.md) | guide | The authenticated offering detail, disclosures and the pre-launch checklist for the funding rail. |
| [investor-profile.md](investor-profile.md) | guide | The investor profile aggregate, eligibility, the display-name cache, wallet registration (AD-241). |
| [wallet-registration-operations.md](wallet-registration-operations.md) | runbook | Running and repairing the wallet registry watcher. |
| [plans/device-bound-auth-backend.md](plans/device-bound-auth-backend.md) | plan | The backend plan for device-bound biometric authentication. Its section 3 must stay byte-identical with the mobile repository's plan (`AGENTS.md:28`). |
| [plans/devops-device-bound-auth.md](plans/devops-device-bound-auth.md) | plan | The infrastructure plan for device-bound authentication and the wallet infrastructure; a plan only. |
| [diagrams/docker-architecture.drawio](diagrams/docker-architecture.drawio) | diagram | The container architecture, in draw.io format. It no longer matches the staging compose file ([operations.md](operations.md#15-known-limitations), item O12). |
| [diagrams/staging-environment-flow.drawio](diagrams/staging-environment-flow.drawio) | diagram | The staging environment and request flow, in draw.io format; same note. |

### 3.5 What the documentation does not cover

The design record (decisions, data model and conflict register) is a separate repository and is not copied here; the chapters name AD numbers and register entries and say where code and record differ. The mobile app and the admin console are not in this repository and were not read. The contents of `.env.staging` and any production configuration are not in the repository (see [status.md](status.md#7-what-has-not-been-verified)).

## 4. How the documents are kept honest

- **One commit per document.** Each chapter starts with the line `Valid for main at <commit> (<date>).` It means that every statement in the file was checked against the code at that commit and says nothing about a later one. The existing guides and plans carry no such line.
- **Citations.** A statement about behaviour carries `(path:line)` or `(path:from-to)` at that commit and names the function or identifier next to the number, because line numbers drift. A number that was not counted does not appear.
- **Not verified.** What could not be checked is written `Not verified: ...` with the reason, and each chapter has a "Not verified" section. The recurring items are collected in [status.md](status.md#7-what-has-not-been-verified).
- **Pending lines.** A line of the form `> Pending #N: one sentence.` sits directly under the statement that open pull request N changes. Nothing under such a line is built on main. [status.md](status.md#3-open-pull-requests-that-change-documented-behaviour) lists the pull requests and the chapters that carry their lines.
- **Defects.** A defect found in the code goes into the "Known limitations" section of the chapter, in neutral wording, with `file:line` and the GitHub issue number where one exists. The documentation does not fix code and does not soften a defect. [status.md](status.md#4-known-limitations) collects them with a risk rating.
- **Gaps against the design record.** Where code and record disagree, the chapter states both and names the conflict register entry or the AD number in a "Known gaps" section. The documentation edits neither the record nor the register.
- **No secrets and no tool names.** A secret appears only as the placeholder name that `.env.example` uses.
- **What the check covers.** Statements were checked against the code at that commit. The "Not verified" section of each chapter lists what that check could not reach.
- **No automated check.** The repository has no step that checks the documents: `.github/workflows/ci.yml` has none. Links and anchors were checked by a script run for this change that is not part of the repository.

The design record's address: `AGENTS.md:5` and `README.md:3` on main still name the removed `../Docs/Backend` tree, while the chapters use the paths of the flattened record (`00-Governance/DECISIONS/ARCHITECTURE_DECISIONS.md`, `04-Engineering/DATA/CORE_TABLES.md`).

> Pending #203: design-record paths in `AGENTS.md`, `README.md`, `docs/document-storage.md` and `docs/investor-offering.md` are updated to the flattened record.

## 5. Vocabulary

The terms below are the ones the code and the chapters use. Each entry is checked against the code at 48aa967 and points to the chapter that explains it.

| Term | Meaning | Source and chapter |
| --- | --- | --- |
| Account | The VistaBlox-side identity of one person: a row in `account.accounts`, keyed by `account_id`, created when Better Auth creates a user; every other module keys on it. | `prisma/schema/schema.prisma:11-68`; [modules/account.md](modules/account.md) |
| AD-nnn | A numbered decision in the design record's ledger (`00-Governance/DECISIONS/ARCHITECTURE_DECISIONS.md` in the sibling repository `vistablox-design-docs`). | `AGENTS.md:5`; [status.md](status.md#5-gaps-between-the-code-and-the-design-record) |
| Anchor (`&app-environment`) | The YAML anchor in the staging compose file that lists the variables passed to the api and the worker containers; a new variable reaches them only if the anchor passes it. | `docker-compose.staging.yml:133`, `:278`; `AGENTS.md:21`; [configuration.md](configuration.md) |
| `APP_ENV` | `staging`, `production` or unset. Staging runs with `NODE_ENV=production`, so staging-only relaxations key on `APP_ENV`, and unset means production. | `src/config/environment.ts:99`; `AGENTS.md:21`; [configuration.md](configuration.md) |
| Authentication level | A session's assurance: `unassured`, `oauth_pending`, `staff_passkey` or `device_biometric`. A customer reaches `/v1` with `device_biometric`, staff with `staff_passkey`. | `src/modules/auth/infrastructure/shared/better-auth.factory.ts:25-30`; [authentication.md](authentication.md) |
| Baseline and tightened tier | The two rate-limit tiers: baseline is 300 requests per 60 seconds, keyed by account after authentication; tightened is 10 per 60 seconds, keyed by IP, on authentication surfaces. "Tight" in a chapter ("tight limiter", "tight IP") is the same tier as "tightened", whose constant is `name: "tightened"` in the code. | `src/shared/http/rate-limit.ts:17-27`; `src/modules/auth/api/shared/require-authentication.ts:114-124`; [api/README.md](api/README.md) |
| Better Auth | The authentication library (1.7.2) that runs inside the api process, is mounted at `/api/auth`, and stores its data in the same database. | `package.json:42`; [api/better-auth.md](api/better-auth.md) |
| Case (intake case) | One property and one applicant moving through the origination pipeline: a row in `intake.intake_cases` with a stage. | `prisma/schema/schema.prisma:259-317`; [modules/intake.md](modules/intake.md) |
| Claim (wallet claim) | A row in `settlement.wallet_registrations` whose `registered_at` and `expired_at` are both null: an address the customer says is theirs, not yet confirmed on chain. It binds nothing until confirmed. | `prisma/schema/schema.prisma:816-849`; [modules/wallet.md](modules/wallet.md) |
| Conflict register entry (`C-nnn`) | A numbered conflict between code and design record in `00-Governance/MIGRATION/CONFLICT_REGISTER.md` of the design repository. | [status.md](status.md#5-gaps-between-the-code-and-the-design-record) |
| Dead letter | A job that exhausted its retries is moved to the queue `maintenance.dead_letter`, where the worker logs it and posts an alert if a webhook is configured. | `src/shared/jobs/job-queues.ts:10`; [dead-letter-jobs.md](dead-letter-jobs.md), [jobs-and-workers.md](jobs-and-workers.md) |
| Disclosure pack | A versioned set of disclosure documents of an offering; one pack is current at a time, and an investor reconfirms against the current pack. | `prisma/schema/schema.prisma:643-658`; [modules/offering.md](modules/offering.md) |
| DPoP | A proof of possession of the device key, sent in the `DPoP` request header and checked on every customer request that is bound to a device; the proof's `htu` is checked against `BETTER_AUTH_URL` plus the request path. | `src/modules/auth/api/shared/require-authentication.ts:131-134` (`readDpopHeader`, reads the header), `:175`, `:220` (`buildHtu(dpop.baseUrl, request.originalUrl)`; `dpop.baseUrl` is `BETTER_AUTH_URL`, `src/server.ts:316`); `src/modules/auth/application/shared/dpop-proof-verifier.ts:186-187` (the `htu` comparison); [authentication.md](authentication.md) |
| Escrow campaign | The on-chain fundraising of one PIV: a row in `settlement.ipo_escrow_campaigns` with the target, the deadline, the treasury address and the last observed state. | `prisma/schema/schema.prisma:946-968`; [modules/settlement.md](modules/settlement.md) |
| EURC | The euro stablecoin that the investor buys through the Coinbase onramp; a purchase funds a reservation when its currency is `EURC` and the credited amount is at least 90 percent of the reserved euro amount. | `src/modules/offering/application/poll-onramp-transactions.service.ts:355-360`; [modules/offering.md](modules/offering.md) |
| Founder | The staff user who holds the `admin_operations` role. The intake chapters ([modules/intake.md](modules/intake.md), [api/intake-customer.md](api/intake-customer.md), [api/intake-staff.md](api/intake-staff.md)) say "the founder", "founder routes" and "founder approval" where the permission chapters say `admin_operations` or the admin chain. | `src/modules/intake/api/intake-operations.router.ts:116` (`requireAdminOperations`); [modules/intake.md](modules/intake.md), [staff-access.md](staff-access.md) |
| Fresh authentication | A customer `device_biometric` session created within the last 5 minutes; routes that move money or change login methods require it. | `src/modules/auth/domain/fresh-authentication.ts:10`, `:25-32`; [authentication.md](authentication.md) |
| Handoff | The job `case_timers.pre_offering_open_handoff`, queued in the transaction of the founder's approval, that creates the PIV and the offering for an approved case. | `src/modules/intake/repository/prisma-intake.repository.ts:2073-2089`, `src/worker.ts:684`; [modules/intake.md](modules/intake.md), [modules/offering.md](modules/offering.md) |
| Idempotency key | The `Idempotency-Key` request header that makes a write safe to retry; stored in `audit.idempotency_keys` under the key and the endpoint name. | `src/shared/http/idempotency.ts:7`; `prisma/schema/schema.prisma:1085-1102`; [api/README.md](api/README.md) |
| Operator key | `CHAIN_OPERATOR_PRIVATE_KEY`: the platform's own wallet key used by the worker and by an operator command. It is not a user's key. | `AGENTS.md:20`; [architecture.md](architecture.md#10-self-custody-and-the-operator-key) |
| Pending line | A `> Pending #N:` line under a statement that open pull request N changes. | [status.md](status.md#3-open-pull-requests-that-change-documented-behaviour) |
| PIV | The per-property row in `intake.pivs`: one per approved property, with its token id; an offering and an escrow campaign each belong to one. The code does not spell out the acronym. | `prisma/schema/schema.prisma:560-590`; [modules/offering.md](modules/offering.md) |
| Population | Whether a Better Auth user is a `customer` or a `staff_partner`; a field of the user that the HTTP API cannot set. | `src/modules/auth/infrastructure/shared/better-auth.factory.ts:164-169`; [staff-access.md](staff-access.md) |
| Recovery case | A staff-reviewed case that restores a customer who lost both login methods: a fresh Didit check, a primary review, a decision by a different reviewer, a cooldown. | `prisma/schema/auth.prisma:161`; [account-recovery.md](account-recovery.md), [api/auth-staff.md](api/auth-staff.md) |
| Reconfirmation window | The period after final terms are published in which a funded reservation must be reconfirmed against the current disclosure pack; its stage is `awaiting_reconfirmation`. | `src/modules/offering/repository/prisma-offering.repository.ts:1040`, `:1158` (`publishFinalOfferingTerms`); [modules/offering.md](modules/offering.md) |
| Reservation | An investor's hold on an amount of an offering: a row in `offering.reservations` with a stage (it starts at `initiated`) and an `Idempotency-Key`; an unfunded `initiated` reservation lapses after 15 minutes. | `prisma/schema/schema.prisma:616-641`; `src/modules/offering/domain/reservation-eligibility.policy.ts:216-222`; [api/offering.md](api/offering.md) |
| Role | A staff or partner permission: `admin_operations`, `legal_partner` or `appraisal_partner`. | `src/modules/auth/repository/staff/staff-invitation.repository.ts:1`; [staff-access.md](staff-access.md) |
| Self-custody | The backend stores wallet addresses and reads balances, never holds a user's key and never signs for a user; transfers return unsigned calldata for the device to sign (AD-240). | `AGENTS.md:20`; [architecture.md](architecture.md#10-self-custody-and-the-operator-key) |
| Signing request | A per-action approval signed on the device; built, with its routes never mounted. | `src/server.ts:665`, `src/app.ts:795-797`; [authentication.md](authentication.md), [status.md](status.md#2-built-and-switched-off) |
| Stage (intake) | The state of a case: `draft`, `submitted`, `waiting_on_applicant`, `pre_offering_open`, `post_ipo_structuring`, `approved_for_final_offering`, and the terminal `rejected`, `withdrawn`, `expired`. | `src/modules/intake/domain/intake-workflow.catalog.ts:3-6`; [modules/intake.md](modules/intake.md) |
| Step-up (WebAuthn) | The second proof that every `/internal/v1` route requires of staff: a session created by a passkey ceremony counts as verified. | `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:32-54`; [staff-access.md](staff-access.md) |
| Trace id | The `x-trace-id` header: taken from the request if present, otherwise generated as `req_` plus a ULID, and returned in the response and the error envelope. | `src/shared/http/request-context.ts:4-14`; [api/README.md](api/README.md) |
| Worker | The second process (`src/worker.ts`): the pg-boss scheduler and consumers, with a loopback probe on `127.0.0.1:3001`. | `src/shared/health/worker-heartbeat.ts:4`; [jobs-and-workers.md](jobs-and-workers.md) |

## 6. Conventions for contributors

When code changes, the chapters that describe it change in the same pull request. The table says which.

| The change | Update |
| --- | --- |
| A route is added, removed or changes its guards, input, answer or error codes | The route chapter under [api/](api/), the route-gating section of [api/README.md](api/README.md), and the module chapter under [modules/](modules/) |
| An error code is added | The catalogue in [api/README.md](api/README.md) |
| A guard, a limiter, a header or another security control changes | [security.md](security.md); for sign-in or sessions also [authentication.md](authentication.md) or [staff-access.md](staff-access.md) |
| A table, column, constraint, trigger or migration is added | [data-model.md](data-model.md) |
| A queue, a schedule or a job's retry behaviour changes | [jobs-and-workers.md](jobs-and-workers.md) and the module chapter |
| A variable is added or changes its default | [configuration.md](configuration.md), `.env.example`, and the `&app-environment` anchor of `docker-compose.staging.yml` if staging needs it |
| A command or an npm script is added | [cli.md](cli.md) |
| An external call is added, or its timeout or failure handling changes | [integrations.md](integrations.md) |
| An image, a compose file, the deploy script or the CI workflow changes | [operations.md](operations.md) or [testing.md](testing.md) |
| A layer, a composition file or a convention changes | [architecture.md](architecture.md) |
| A defect is found | The "Known limitations" section of the chapter that owns the code, with `file:line` and the issue number, and a row in [status.md](status.md#4-known-limitations) |
| A pull request changes documented behaviour and is not yet merged | A `> Pending #N:` line under each statement it changes, and a row in the table of [status.md](status.md#3-open-pull-requests-that-change-documented-behaviour) |
| A pull request listed in `status.md` is merged | The steps of [status.md](status.md#8-how-to-update-this-page-after-a-merge) |

Rules that apply to every edit:

1. Change the `Valid for main at ...` line of a file only when you re-checked the whole file against the new commit.
2. Give every statement about behaviour a `(path:line)` citation with the identifier, and write what you could not check as `Not verified: ...` with the reason.
3. Use the present tense for what exists, exact names for routes, error codes, variables, queues, tables and files, and tables for reference data. A pull request that is not merged is described only in a `Pending` line.
4. Do not edit the design record from here. Record a disagreement in the chapter's "Known gaps" section and name the register entry or the AD number.
5. Link between documents with relative links and keep every file of `docs/` linked from this page.
6. Do not edit the existing guides to repair a chapter; where a guide is wrong, say so in the chapter and open an issue.
