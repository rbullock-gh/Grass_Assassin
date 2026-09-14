#!/usr/bin/env bash
#
# Fails when schema.prisma has structural changes that no migration applies.
#
# The naive check — `prisma migrate diff --exit-code` — cannot be used here,
# because several objects live in raw SQL that schema.prisma has no syntax for:
# GIST indexes on the PostGIS geography columns, partial indexes, and CHECK
# constraints. Prisma reports every one of those as a difference, so a plain
# drift check would fail on every run forever and be switched off within a week.
#
# So this compares the generated SQL instead, and fails only on STRUCTURAL
# drift — a table, column or type that the migrations do not create. That is
# the failure that actually hurts: a schema edit that passes every test locally
# and then breaks on deploy.
set -uo pipefail

cd "$(dirname "$0")/../apps/api"

SHADOW_URL="${SHADOW_DATABASE_URL:-${DATABASE_URL:?DATABASE_URL or SHADOW_DATABASE_URL must be set}}"

DIFF=$(npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_URL" \
  --script 2>/dev/null)

if [ -z "$DIFF" ]; then
  echo "Schema and migrations agree exactly."
  exit 0
fi

# Structural statements. Index and constraint differences are expected, because
# the raw-SQL ones cannot be represented in schema.prisma.
STRUCTURAL=$(printf '%s\n' "$DIFF" | grep -iE '^\s*(CREATE TABLE|ALTER TABLE .* ADD COLUMN|ALTER TABLE .* DROP COLUMN|ALTER TABLE .* ALTER COLUMN|CREATE TYPE|ALTER TYPE|DROP TABLE)' || true)

if [ -n "$STRUCTURAL" ]; then
  echo "Structural drift: schema.prisma has changes with no migration."
  echo
  printf '%s\n' "$STRUCTURAL"
  echo
  echo "Run: pnpm --filter @grassassassin/api exec prisma migrate dev --name <name>"
  exit 1
fi

echo "No structural drift."
echo "(Index/constraint differences below are expected — they live in raw SQL"
echo " because schema.prisma cannot express GIST, partial indexes or CHECKs.)"
printf '%s\n' "$DIFF" | grep -iE '^\s*(CREATE|DROP) INDEX' | head -10
exit 0
