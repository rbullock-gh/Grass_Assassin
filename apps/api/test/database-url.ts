/**
 * Where the test suite points, decided in exactly one place.
 *
 * This is its own module with no imports on purpose. Importing `@prisma/client`
 * has a side effect: Prisma 6 discovers `prisma.config.ts`, which dotenv-loads
 * `apps/api/.env` and with it the DEVELOPMENT database URL. dotenv does not
 * overwrite a variable that is already set, so whoever decides this has to
 * decide it before Prisma is imported — and both the global setup and the
 * per-file setup need the same answer.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://grass:grass@localhost:5432/grassassassin_test'

/** Pins DATABASE_URL for this process and returns it. Respects one already set. */
export function resolveTestDatabaseUrl(): string {
  process.env.DATABASE_URL ??= DEFAULT_TEST_DATABASE_URL
  return process.env.DATABASE_URL
}
