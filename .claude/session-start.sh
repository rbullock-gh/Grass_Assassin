#!/usr/bin/env bash
# Brings the development database up.
#
# Claude Code on the web runs in an ephemeral container that does not persist a
# running PostgreSQL between sessions, so the API's integration tests — which
# deliberately use a real database rather than mocks — fail on a cold start
# until this runs.
#
# Idempotent and safe to run repeatedly.
set -uo pipefail

if ! command -v pg_isready > /dev/null 2>&1; then
  echo "PostgreSQL client not installed; skipping database startup."
  exit 0
fi

if pg_isready -q 2>/dev/null; then
  echo "PostgreSQL already running."
else
  echo "Starting PostgreSQL…"
  service postgresql start > /dev/null 2>&1 || /etc/init.d/postgresql start > /dev/null 2>&1
  for _ in $(seq 1 20); do
    pg_isready -q 2>/dev/null && break
    sleep 0.5
  done
fi

if ! pg_isready -q 2>/dev/null; then
  echo "PostgreSQL did not come up. Integration tests will fail until it does."
  exit 0
fi

# The role and database the app expects. Both are no-ops if they already exist.
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='grass'\"" 2>/dev/null | grep -q 1 \
  || su postgres -c "psql -q -c \"CREATE ROLE grass WITH LOGIN SUPERUSER PASSWORD 'grass';\"" > /dev/null 2>&1

su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='grassassassin_dev'\"" 2>/dev/null | grep -q 1 \
  || su postgres -c "createdb -O grass grassassassin_dev" > /dev/null 2>&1

TABLES=$(PGPASSWORD=grass psql -h localhost -U grass -d grassassassin_dev -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)

if [ "${TABLES:-0}" -lt 10 ]; then
  echo "Applying migrations…"
  (cd apps/api && npx prisma migrate deploy > /dev/null 2>&1) \
    && echo "Migrations applied." \
    || echo "Migrations failed — run 'pnpm --filter @grassassassin/api db:deploy' manually."
else
  echo "Database ready (${TABLES} tables)."
fi
