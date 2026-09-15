/**
 * Load test: the claim race, and the map.
 *
 * The claim is proven correct under concurrency by the integration suite, but
 * correct and fast are different questions and only one of them had been asked.
 * Two things matter in a real market:
 *
 *   1. When N workers lunge at the same job, exactly one wins — and the losers
 *      find out quickly. A correct claim that takes four seconds to refuse is a
 *      worker staring at a spinner while the job disappears.
 *   2. The map query is the screen every worker opens, repeatedly. It is a
 *      PostGIS radius search with a GIST index, and an index that stops being
 *      used under concurrency shows up here and nowhere else.
 *
 * Usage: node scripts/load-test.mjs [--claimers 40] [--searches 300] [--concurrency 25]
 */
import { PrismaClient } from '@prisma/client'
import { SignJWT } from 'jose'
import { readFileSync } from 'node:fs'

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}

const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '')

/** The API signs with this; reading it here keeps the tokens genuinely valid. */
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? (() => {
  const env = readFileSync(new URL('../apps/api/.env', import.meta.url), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith('JWT_ACCESS_SECRET='))
  if (!line) throw new Error('No JWT_ACCESS_SECRET — set it or put it in apps/api/.env')
  return line.slice('JWT_ACCESS_SECRET='.length).trim()
})()
const CLAIMERS = argOf('--claimers', 40)
const SEARCHES = argOf('--searches', 300)
const CONCURRENCY = argOf('--concurrency', 25)

const db = new PrismaClient()

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** Percentiles say more than a mean: the mean hides the worker who waited. */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  }
}

const show = (label, s) =>
  console.log(
    `  ${label.padEnd(28)} n=${String(s.n).padStart(4)}  ` +
    `p50 ${s.p50.toFixed(0).padStart(4)}ms  p95 ${s.p95.toFixed(0).padStart(4)}ms  ` +
    `p99 ${s.p99.toFixed(0).padStart(4)}ms  max ${s.max.toFixed(0)}ms`,
  )

/**
 * Mints an access token directly, instead of logging in.
 *
 * The first version of this signed everyone in through /auth/login and was
 * refused with a 429 after ten attempts — the brute-force limiter doing exactly
 * its job, since all of this comes from one address. Real workers arrive from
 * hundreds of addresses, so that limit is not what is being measured here, and
 * fighting it would only measure the limiter.
 *
 * Signed with the API's own secret, so these are ordinary valid tokens.
 */
async function tokenFor(userId, roles) {
  const secret = new TextEncoder().encode(ACCESS_SECRET)
  // Issuer and audience included because verifyAccessToken requires them. The
  // first version left them out, every request came back 401, and the run
  // reported "0 winners" as though the claim were broken.
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer('grassassassin')
    .setAudience('grassassassin-app')
    .setExpirationTime('1h')
    .sign(secret)
}

async function timed(fn) {
  const started = performance.now()
  const value = await fn()
  return { ms: performance.now() - started, value }
}

/** Runs tasks with a ceiling on how many are in flight, like real clients. */
async function pooled(tasks, limit) {
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const mine = next++
      results[mine] = await tasks[mine]()
    }
  }))
  return results
}

async function main() {
  console.log(`API ${API}  ·  ${CLAIMERS} claimers  ·  ${SEARCHES} searches  ·  concurrency ${CONCURRENCY}\n`)

  /*
   * Workers who can ACTUALLY claim, and a job that can ACTUALLY be claimed.
   *
   * The first version scavenged `findFirst({ status: 'POSTED' })` and any user
   * with a WORKER role. Run it a few hours after seeding and every attempt came
   * back LOST — the chosen job's deadline had passed, two workers had never
   * finished onboarding, and three were already at their active-job cap from
   * earlier runs of this very script. The report read "0 winners", as though
   * the claim race were broken, when the claim code had behaved perfectly and
   * the fixture had rotted.
   *
   * So: filter by the same conditions the claim itself enforces, and if there
   * are not enough, say which one is missing instead of measuring nothing.
   */
  const ACTIVE_CLAIM_STATUSES = [
    'CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'DISPUTED',
  ]

  const profiles = await db.workerProfile.findMany({
    where: { status: 'APPROVED', user: { status: 'ACTIVE', roles: { has: 'WORKER' } } },
    select: {
      userId: true, maxActiveJobs: true,
      user: { select: { id: true, roles: true } },
    },
    take: CLAIMERS * 3,
  })

  const eligible = []
  for (const profile of profiles) {
    const active = await db.job.count({
      where: { claimedByWorkerId: profile.userId, status: { in: ACTIVE_CLAIM_STATUSES } },
    })
    if (active < profile.maxActiveJobs) eligible.push(profile.user)
    if (eligible.length >= CLAIMERS) break
  }

  const workers = eligible
  if (workers.length < 2) {
    throw new Error(
      `Only ${workers.length} worker(s) can claim right now — approved, active, and under ` +
      `their job cap. ${profiles.length} approved profiles exist, so the rest are holding ` +
      'active jobs. Re-seed before load testing: `pnpm --filter @grassassassin/api db:seed`.',
    )
  }
  console.log(`Using ${workers.length} workers who can actually claim`)
  const tokens = await Promise.all(workers.map((w) => tokenFor(w.id, w.roles)))

  // ---- 1. the map ---------------------------------------------------------
  console.log('\n── the map, under repeated load')
  const searchTimings = []
  let searchErrors = 0
  await pooled(
    Array.from({ length: SEARCHES }, (_, i) => async () => {
      const token = tokens[i % tokens.length]
      const { ms, value } = await timed(() => fetch(
        `${API}/v1/jobs/search?lat=36.1627&lng=-86.7816&radiusMiles=15&sort=DISTANCE&limit=50`,
        { headers: { authorization: `Bearer ${token}` } },
      ))
      if (value.status === 401) {
        throw new Error('The API rejected our token — check JWT_ACCESS_SECRET matches the server.')
      }
      if (!value.ok) searchErrors += 1
      await value.arrayBuffer()
      searchTimings.push(ms)
    }),
    CONCURRENCY,
  )

  const search = stats(searchTimings)
  show('radius search', search)
  check(searchErrors === 0, 'every search returned a result', `${searchErrors} failed`)
  // A worker refreshing a map will not wait a second for it. This is a generous
  // ceiling on a laptop-class machine sharing a CPU with Postgres.
  check(search.p95 < 1000, 'p95 under a second', `${search.p95.toFixed(0)}ms`)

  // ---- 2. the claim race --------------------------------------------------
  console.log('\n── every worker lunges at the same job')
  const job = await db.job.findFirst({
    // dueAt in the future, because the claim refuses an expired job with
    // NOT_AVAILABLE — which looks exactly like a broken race from out here.
    where: { status: 'POSTED', dueAt: { gt: new Date() } },
    orderBy: { dueAt: 'desc' },
    select: { id: true, title: true, dueAt: true },
  })
  if (!job) {
    const stale = await db.job.count({ where: { status: 'POSTED' } })
    throw new Error(
      `No claimable job to fight over. ${stale} job(s) are POSTED but every one of them is ` +
      'past its deadline, so the claim would refuse them all. Re-seed: ' +
      '`pnpm --filter @grassassassin/api db:seed`.',
    )
  }

  const claimTimings = []
  const outcomes = []
  await Promise.all(tokens.map((token) => (async () => {
    const { ms, value } = await timed(() => fetch(`${API}/v1/jobs/${job.id}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const body = await value.json().catch(() => ({}))
    claimTimings.push(ms)
    // The reason is kept, not just the outcome. A run that reports 15 bare
    // "LOST" hides whether the claim raced correctly or whether every worker
    // was ineligible before the race began.
    outcomes.push({
      status: value.status,
      outcome: body.outcome ?? body?.error?.code ?? 'unknown',
      reason: body.reason ?? null,
    })
  })()))

  const claim = stats(claimTimings)
  show('claim attempt', claim)

  // What actually came back, always printed. A run that says "0 winners" and
  // nothing else reads like the claim is broken; the first three times this
  // suite said that, the cause was a malformed token, then a missing issuer,
  // then the rate limiter — none of them the claim.
  const tally = new Map()
  for (const o of outcomes) {
    const key = `${o.status} ${o.outcome}${o.reason ? `/${o.reason}` : ''}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  console.log(`  outcomes: ${[...tally].map(([k, n]) => `${n}× ${k}`).join(', ')}`)

  /*
   * A 429 is the rate limiter shedding load, not the claim refusing a loser.
   * Counting it as a clean refusal would let this suite report a green claim
   * race in a run where nobody's claim ever reached the claim code.
   */
  const throttled = outcomes.filter((o) => o.status === 429)
  check(
    throttled.length === 0,
    'no claim was turned away by the rate limiter',
    `${throttled.length} of ${outcomes.length} got 429 — this run measured the ` +
    'limiter, not the claim. Every request here comes from one address; real ' +
    'workers do not. Lower --concurrency or raise the limit for the run.',
  )

  const winners = outcomes.filter((o) => o.outcome === 'WON')
  check(winners.length === 1, 'exactly one worker won', `${winners.length} winners`)

  const refused = outcomes.filter((o) => o.status !== 429 && (o.status >= 400 || o.outcome !== 'WON'))
  check(
    refused.length === outcomes.length - 1,
    'everyone else was refused cleanly',
    `${refused.length} of ${outcomes.length - 1}`,
  )
  check(
    outcomes.every((o) => o.status < 500),
    'nobody got a server error',
    outcomes.filter((o) => o.status >= 500).map((o) => o.status).join(','),
  )
  // The loser's answer is what decides whether they keep using the app.
  check(claim.p95 < 2000, 'losers found out within two seconds', `p95 ${claim.p95.toFixed(0)}ms`)

  // ---- 3. the books still add up -----------------------------------------
  console.log('\n── after all that')
  const [{ delta }] = await db.$queryRawUnsafe(
    'SELECT COALESCE(SUM("amountCents"),0)::bigint AS delta FROM "ledger_entries"',
  )
  check(Number(delta) === 0, 'the ledger still nets to zero', String(delta))

  const claimed = await db.job.count({ where: { id: job.id, claimedByWorkerId: { not: null } } })
  check(claimed === 1, 'the job has exactly one claimant in the database')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
  .catch((error) => { console.error(error); process.exit(1) })
  .finally(() => db.$disconnect())
