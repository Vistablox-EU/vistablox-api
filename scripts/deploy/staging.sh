#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
environment_file="$project_root/.env.staging"
compose_file="$project_root/docker-compose.staging.yml"

if [ ! -r "$environment_file" ]; then
  echo "Missing staging environment file: $environment_file" >&2
  exit 1
fi

if ! grep -qE '^POSTGRES_PASSWORD=.+$' "$environment_file"; then
  echo "Missing POSTGRES_PASSWORD in $environment_file" >&2
  exit 1
fi

docker compose --env-file "$environment_file" -f "$compose_file" config -q
docker compose --env-file "$environment_file" -f "$compose_file" up -d --build --remove-orphans
