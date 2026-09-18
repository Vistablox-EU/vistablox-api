# vistablox-api — agent notes

API-only backend: Express 5, TypeScript, Zod, Prisma 7 on PostgreSQL 18, a pg-boss worker, Better Auth. `README.md` lists what is already built.

The design record lives in `../Docs/Backend` (repo `vistablox-design-docs`). Start at its `README.md`, then `VISTABLOX_BACKEND_DISCUSSION.md` and `15-Decisions-and-Rationale/ARCHITECTURE_DECISIONS.md` (the AD-### decisions). When code and the design record disagree, the record and `03-Database/CORE_TABLES.md` win. Flag the conflict instead of silently picking one.

## Commands

- `npm run check` runs typecheck, the dependency-cruiser architecture rules, and vitest. Run it before calling a change done.
- `npm test`: unit tests always run. `tests/*.integration.test.ts` skip themselves unless `TEST_DATABASE_URL` points at a local Postgres 18 test database (see README "Testing"). Say so when they were skipped.
- `npm run db:migrate:dev` is for local databases only. Never run `db:migrate:deploy` against anything but a local database. Neon is production-only (AD-257).

## Architecture rules

`dependency-cruiser.config.cjs` enforces the first two.

- Layering inside `src/modules/<domain>/`: `api` (router + schema) → `application` (service) → `domain` (policy) → `repository`. `api` never imports `repository`. `domain` stays pure: no infrastructure, HTTP, or other layers. No importing another module's `domain`/`application`/`repository`. No cycles.
- Cross-domain state changes go through pg-boss jobs via `src/shared/jobs/enqueue-job.ts`, inside the caller's transaction (AD-145). Never use a direct synchronous call.
- Authentication, session, and login-method mechanics live only in `src/modules/auth/`, under `/v1/auth/*`. `response.locals.authContext` is set only in `auth/api/require-authentication.ts`. Other routers get that middleware injected and only read it.
- Self-custody (AD-240): the backend stores wallet addresses and reads balances. It never holds a user's key or signs for a user. Transfers return unsigned calldata for the device to sign. `CHAIN_OPERATOR_PRIVATE_KEY` is the platform's own wallet, a separate thing.
- Staging runs `NODE_ENV=production`. Staging-only relaxations key on `APP_ENV`: unset means production, so they fail closed. A new env var reaches the containers only if the `&app-environment` anchor in `docker-compose.staging.yml` passes it.
- Errors use the documented envelope: `type`, `code`, `title`, `status`, `detail`, `trace_id`, optional `field_errors`.

## Git and PRs

- Branch from an up-to-date `main`, with one branch and one PR per change. Never commit to `main` directly.
- Open PRs with `gh pr create` and don't merge them. Damir or the vistablox-DevOps session reviews, merges, and deploys. Merging to `main` does not deploy staging.
- Section 3 ("Shared wire contract") of `docs/plans/device-bound-auth-backend.md` must stay byte-identical with `vistablox-mobile/docs/plans/device-bound-auth-mobile.md`. Change both or neither.
