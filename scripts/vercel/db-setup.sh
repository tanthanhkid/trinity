#!/usr/bin/env bash
# Runs during the Vercel build, BEFORE `next build`: applies Prisma migrations and seeds the first admin.
# Both steps are idempotent, so every redeploy is safe.
#
#   DATABASE_URL            required (any Postgres, e.g. the Neon integration)
#   DATABASE_URL_UNPOOLED   optional; used for migrations when present (pooled/PgBouncer URLs can break DDL)
#   SEED_ADMIN_EMAIL        first admin email (default admin@example.com)
#   SEED_ADMIN_PASSWORD     first admin password; if unset a random one is generated and printed ONCE in the build log
#   SEED_DEMO_DATA          "true" to add a few sample contacts (default false)
#   SKIP_DB_SEED=1          apply migrations but skip the seed (an existing instance that must not get a first admin)
#   SKIP_DB_SETUP=1         skip this step entirely
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${SKIP_DB_SETUP:-}" = "1" ]; then echo "[db-setup] SKIP_DB_SETUP=1, skipping"; exit 0; fi
if [ "${VERCEL_ENV:-production}" = "preview" ] && [ "${DB_SETUP_ON_PREVIEW:-}" != "1" ]; then
  echo "[db-setup] preview deployment, skipping (set DB_SETUP_ON_PREVIEW=1 to run here)"; exit 0
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[db-setup] DATABASE_URL is not set. Add a Postgres database to the project (Vercel Storage > Neon) and redeploy." >&2
  exit 1
fi

export DATABASE_URL="${DATABASE_URL_UNPOOLED:-${POSTGRES_URL_NON_POOLING:-$DATABASE_URL}}"
export SEED_DEMO_DATA="${SEED_DEMO_DATA:-false}"
echo "[db-setup] applying migrations"
pnpm --dir "$ROOT" --filter @trinity/prisma migrate:deploy
if [ "${SKIP_DB_SEED:-}" = "1" ]; then echo "[db-setup] SKIP_DB_SEED=1, not seeding"; exit 0; fi
echo "[db-setup] seeding (idempotent)"
pnpm --dir "$ROOT" --filter @trinity/prisma seed
