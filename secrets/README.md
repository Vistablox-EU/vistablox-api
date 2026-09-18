# Staging configuration

`.env.staging` is the sole source of staging configuration, including secrets.
It is ignored by Git and must remain owner-readable only (`0600`). Do not put
staging values in Coolify, shell profiles, or `secrets/staging.env`.

Before deploying, ensure `.env.staging` contains every application setting and
`POSTGRES_PASSWORD`. Compose uses that password only for its private staging
PostgreSQL service and overrides the application's database URLs accordingly.

Run `scripts/deploy/staging.sh`. It passes `.env.staging` directly to Docker
Compose, validates the resolved configuration, and starts the stack. No SOPS
binary, temporary decrypted file, or second secret source is involved.
