/**
 * Test environment defaults.
 *
 * Integration tests run against a real PostgreSQL + PostGIS database. There is
 * no mocking layer: the behavior under test — row-level locking semantics under
 * concurrent conditional UPDATEs — exists only in the database, so a mock would
 * prove nothing at all.
 */
process.env.NODE_ENV ??= 'test'
process.env.DATABASE_URL ??= 'postgresql://grass:grass@localhost:5432/grassassassin_test'
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-characters-long'

/**
 * A guard rail, because this suite TRUNCATES every table before each test.
 *
 * It used to default to the development database, so running the tests silently
 * wiped whatever a developer had seeded — and the only thing standing between
 * that behaviour and a real database was one environment variable pointing
 * somewhere else. A destructive suite should not be one typo from a production
 * URL, so it refuses to start unless the target names itself a test database.
 *
 * Deliberately a name check rather than a host check: "it is only localhost" is
 * exactly the assumption that stops being true the first time someone runs the
 * suite against a tunnel or a shared container.
 */
const TEST_DATABASE_PATTERN = /(^|[_-])test(_|$)|_test$/i

const url = new URL(process.env.DATABASE_URL)
const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''))

if (!TEST_DATABASE_PATTERN.test(databaseName)) {
  throw new Error(
    `Refusing to run: the test suite truncates every table, and "${databaseName}" is not a test database.\n` +
    `Point DATABASE_URL at a database whose name contains "test", for example:\n` +
    `  DATABASE_URL=postgresql://grass:grass@localhost:5432/grassassassin_test\n` +
    `Create it with: createdb grassassassin_test && pnpm --filter @grassassassin/api prisma migrate deploy`,
  )
}

/**
 * A deliberate clock shift, for finding tests that only pass at certain hours.
 *
 * Two have already been found the hard way. A "due today" fixture anchored to
 * four hours from now crossed local midnight and failed for four hours of every
 * day; three notification tests asserted a push was delivered while the code
 * correctly suppressed it during quiet hours, failing for ten. Both looked like
 * flakes and were not — they were the suite being wrong about what time it was.
 *
 * Running with TEST_CLOCK_OFFSET_HOURS set moves the whole suite's idea of now,
 * so the next one can be found on purpose instead of at 3am in CI:
 *
 *   TEST_CLOCK_OFFSET_HOURS=8 pnpm --filter @grassassassin/api test
 *
 * Unset — which is every normal run — this does nothing at all.
 */
const offsetHours = Number(process.env.TEST_CLOCK_OFFSET_HOURS ?? '0')
if (Number.isFinite(offsetHours) && offsetHours !== 0) {
  const shiftMs = offsetHours * 3_600_000
  const RealDate = Date

  class ShiftedDate extends RealDate {
    // `new Date()` means "now", which is the only case that shifts. Every other
    // form names an explicit instant and must be left exactly alone, or the
    // fixtures move with the clock and the drill proves nothing.
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + shiftMs)
      else super(...(args as ConstructorParameters<typeof Date>))
    }
    static override now(): number {
      return RealDate.now() + shiftMs
    }
  }

  globalThis.Date = ShiftedDate as DateConstructor
  console.log(`[clock] running as if it were ${offsetHours}h from now: ${new Date().toISOString()}`)
}
