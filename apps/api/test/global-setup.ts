import type { PrismaClient } from '@prisma/client'
import { resolveTestDatabaseUrl } from './database-url.js'

/**
 * One run of this suite at a time, per database.
 *
 * The suite truncates every table before each test. Two runs sharing a database
 * therefore delete each other's fixtures mid-test, and the failures that come
 * out do NOT look like a race — they look like real regressions. A run that
 * overlapped another one here produced 21 failures including
 * `expected 401 to be 201` on authenticated routes, a foreign key violation
 * writing a notification, and a rate-limiter test reporting that one user had
 * exhausted another's budget. Every one of those is a plausible, frightening
 * security bug. All of them were noise, and finding that out cost a full
 * diagnostic cycle that began by blaming the wrong process entirely.
 *
 * A Postgres advisory lock is the cheapest fix available: it lives in the same
 * database the collision happens in, so it cannot be defeated by running from a
 * different directory, a different shell, or a different container.
 *
 * It waits rather than failing outright, because the common case by far is a
 * previous run that is thirty seconds from finishing. It gives up after two
 * minutes with an explanation, because the second most common case is a
 * developer staring at a terminal that appears to have hung.
 */

// An arbitrary but fixed 64-bit key. Another application would have to be using
// advisory locks on this database AND collide with exactly this number.
const LOCK_KEY = 7_314_159_265_358_979n

const WAIT_TIMEOUT_MS = 120_000
const POLL_MS = 500

/**
 * Advisory locks belong to a CONNECTION, and Prisma pools connections — so a
 * lock taken on a pooled client can be held by one connection and looked for on
 * another. Pinning the pool to a single connection removes the ambiguity, and
 * this client does nothing else, so a pool of one costs nothing.
 */
function singleConnectionUrl(raw: string): string {
  const url = new URL(raw)
  url.searchParams.set('connection_limit', '1')
  url.searchParams.set('pool_timeout', '30')
  return url.toString()
}

let lockClient: PrismaClient | undefined

export async function setup(): Promise<void> {
  /*
   * globalSetup runs BEFORE setupFiles, so nothing has pinned DATABASE_URL yet
   * — and importing Prisma is what makes that urgent rather than tidy. The
   * import loads `prisma.config.ts`, which dotenv-loads the development URL
   * into a variable nobody has claimed. Pin it first, then import: dotenv
   * leaves a variable that is already set alone.
   *
   * The suite's own guard caught this the first time it happened, refusing to
   * truncate a database not named for testing. It should not have had to.
   */
  const databaseUrl = resolveTestDatabaseUrl()
  const { PrismaClient } = await import('@prisma/client')

  lockClient = new PrismaClient({
    datasources: { db: { url: singleConnectionUrl(databaseUrl) } },
  })
  await lockClient.$connect()

  const started = Date.now()
  let announced = false

  for (;;) {
    const rows = await lockClient.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${LOCK_KEY}::bigint) AS locked
    `
    if (rows[0]?.locked) return

    if (!announced) {
      announced = true
      console.log(
        '[test-lock] Another run of this suite holds this database. Waiting for it to finish.\n'
        + '            Both runs truncate every table, so letting them overlap would produce\n'
        + '            failures that look like real bugs and are not.',
      )
    }

    if (Date.now() - started > WAIT_TIMEOUT_MS) {
      await teardown()
      throw new Error(
        `Gave up after ${WAIT_TIMEOUT_MS / 1000}s waiting for another run of this suite to release\n`
        + `the test database.\n\n`
        + `Either a run is genuinely still going — let it finish — or one died without releasing.\n`
        + `Advisory locks are held per connection, so a dead run's lock clears when its connection\n`
        + `does. To see what is holding it:\n\n`
        + `  psql "$DATABASE_URL" -c "SELECT a.pid, a.application_name, a.state FROM pg_locks l `
        + `JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory'"\n`,
      )
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

export async function teardown(): Promise<void> {
  if (!lockClient) return
  // Disconnecting releases the lock by itself; unlocking first keeps the intent
  // legible and makes a connection that somehow outlives us harmless.
  await lockClient.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`.catch(() => undefined)
  await lockClient.$disconnect().catch(() => undefined)
  lockClient = undefined
}
