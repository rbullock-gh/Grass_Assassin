import { Prisma } from '@prisma/client'
import type { Db } from '../../lib/prisma.js'
import type { Queue } from './queue.js'
import { SCHEDULES } from './queue.js'
import type { Notifier } from '../notifications/notifier.js'
import type { SettlementDeps } from '../payments/settlement.js'
import { sweepExpiredReservations } from '../jobs/claim.js'
import { autoApproveStaleJobs, expireUnclaimedJobs } from '../jobs/lifecycle.js'
import { refreshPremiumFlags, createJob } from '../jobs/repository.js'
import { findWorkersToNotify } from '../geo/job-search.js'
import { recalculateReputation } from '../gamification/points.js'
import { resolvePolicy } from '../payments/fee-config.js'
import { metersToMiles, periodBoundsFor } from '@grassassassin/shared'

/**
 * The automation layer.
 *
 * These handlers are what make the marketplace feel alive rather than like a
 * form that writes rows: jobs find workers, deadlines announce themselves,
 * money moves without anyone clicking, and a silent customer never strands a
 * worker's payment.
 *
 * Each handler is independently retryable and safe to run twice. The queue
 * retries on failure, so anything that is not idempotent will eventually be
 * applied more than once.
 */

export interface AutomationDeps extends SettlementDeps {
  queue: Queue
  notifier: Notifier
}

export function registerHandlers(deps: AutomationDeps): void {
  const { queue } = deps

  // The handlers return counts because that is what makes them directly
  // assertable in tests; the queue port only cares that they settle. Wrapping
  // rather than widening JobHandler keeps "returns nothing useful" from
  // becoming the norm for future handlers.
  const discard = <T>(work: Promise<T>): Promise<void> => work.then(() => undefined)

  queue.on('notify.job-posted', (payload) => discard(onJobPosted(deps, payload.jobId)))
  queue.on('notify.deadline-reminder', (payload) => discard(onDeadlineReminder(deps, payload)))
  queue.on('notify.approval-reminder', (payload) => discard(onApprovalReminder(deps, payload.jobId)))
  queue.on('sweep.expired-claims', () => discard(onSweepExpiredClaims(deps)))
  queue.on('sweep.auto-approve', () => discard(onSweepAutoApprove(deps)))
  queue.on('sweep.expire-jobs', () => discard(onSweepExpireJobs(deps)))
  queue.on('recompute.reputation', (payload) => discard(onRecomputeReputation(deps, payload.workerUserId)))
  queue.on('recompute.leaderboards', () => discard(onRecomputeLeaderboards(deps)))
  queue.on('recompute.premium-flags', () => discard(onRefreshPremiumFlags(deps)))
  queue.on('recurring.generate', () => discard(onGenerateRecurringJobs(deps)))
}

export async function registerSchedules(queue: Queue): Promise<void> {
  for (const entry of Object.values(SCHEDULES)) {
    await queue.schedule(entry.name, {} as never, entry.cron)
  }
}

// ---------------------------------------------------------------------------
// Job matching
// ---------------------------------------------------------------------------

/**
 * Tells nearby qualified workers about a new job, and schedules its reminders.
 *
 * "Qualified" means approved, active, offering that category, and with the job
 * inside THEIR service radius — not a fixed distance. A worker who set a 5-mile
 * radius has said something meaningful and pushing past it teaches them to
 * ignore us.
 */
export async function onJobPosted(deps: AutomationDeps, jobId: string): Promise<number> {
  const { db, notifier, queue } = deps

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true, status: true, categoryId: true, customerId: true,
      priceCents: true, workerPayoutCents: true, dueAt: true,
      category: { select: { name: true } },
    },
  })
  if (!job || job.status !== 'POSTED') return 0

  const location = await db.$queryRaw<Array<{ lat: number; lng: number }>>(Prisma.sql`
    SELECT ST_Y("approxLocation"::geometry) AS lat, ST_X("approxLocation"::geometry) AS lng
      FROM "jobs" WHERE "id" = ${jobId}
  `)
  const point = location[0]
  if (!point) return 0

  const candidates = await findWorkersToNotify(db, { lat: point.lat, lng: point.lng }, job.categoryId)

  const recipients = candidates
    // Never tell someone about their own job.
    .filter((candidate) => candidate.userId !== job.customerId)
    .map((candidate) => ({
      userId: candidate.userId,
      type: 'JOB_MATCH' as const,
      title: `💰 $${Math.round(job.priceCents / 100)} ${job.category.name}`,
      body: `${metersToMiles(candidate.distanceMeters).toFixed(1)} miles away · you earn $${(job.workerPayoutCents / 100).toFixed(2)}`,
      data: { jobId: job.id, kind: 'JOB_MATCH' },
    }))

  const delivered = await notifier.notifyMany(recipients)

  // Deadline reminders are scheduled at post time rather than swept for,
  // so a job posted with a two-hour deadline still gets its warning.
  const msUntilDue = job.dueAt.getTime() - Date.now()
  for (const hoursBefore of [24, 3]) {
    const delayMs = msUntilDue - hoursBefore * 3_600_000
    if (delayMs > 0) {
      await queue.enqueue(
        'notify.deadline-reminder',
        { jobId: job.id, hoursBefore },
        { delayMs, dedupeKey: `deadline:${job.id}:${hoursBefore}` },
      )
    }
  }

  return delivered
}

/** Reminds the assigned worker that a deadline is approaching. */
export async function onDeadlineReminder(
  deps: AutomationDeps,
  params: { jobId: string; hoursBefore: number },
): Promise<boolean> {
  const { db, notifier } = deps

  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true, status: true, claimedByWorkerId: true, dueAt: true,
      category: { select: { name: true } },
    },
  })
  // Only an in-flight job needs a reminder. A completed or cancelled one must
  // not buzz someone about work they already finished.
  if (!job?.claimedByWorkerId) return false
  if (!['CLAIMED', 'EN_ROUTE', 'IN_PROGRESS'].includes(job.status)) return false

  const hours = params.hoursBefore
  return notifier.notify({
    userId: job.claimedByWorkerId,
    type: 'DEADLINE_REMINDER',
    title: hours >= 24 ? 'Job due tomorrow' : `Job due in ${hours} hours`,
    body: `${job.category.name} is due ${job.dueAt.toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}.`,
    data: { jobId: job.id },
    // A deadline a worker is about to miss is worth waking them for.
    force: hours <= 3,
  })
}

/** Warns a customer before their silence auto-approves the work. */
export async function onApprovalReminder(deps: AutomationDeps, jobId: string): Promise<boolean> {
  const { db, notifier } = deps

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, customerId: true, category: { select: { name: true } } },
  })
  if (!job || job.status !== 'PENDING_APPROVAL') return false

  return notifier.notify({
    userId: job.customerId,
    type: 'APPROVAL_REMINDER',
    title: 'Review your completed job',
    body: `Your ${job.category.name} is finished. It approves automatically in 4 hours.`,
    data: { jobId: job.id },
  })
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

export async function onSweepExpiredClaims(deps: AutomationDeps): Promise<number> {
  return sweepExpiredReservations(deps.db)
}

/**
 * Auto-approves stale work, and warns customers before it happens.
 *
 * The warning matters: a customer who discovers they were charged without ever
 * approving feels taken from, even when the work was fine.
 */
export async function onSweepAutoApprove(deps: AutomationDeps): Promise<number> {
  const { db, queue } = deps
  const policy = await resolvePolicy(db, null)

  const warnAfterHours = Math.max(1, policy.autoApprovalHours - 4)
  const warnCutoff = new Date(Date.now() - warnAfterHours * 3_600_000)

  const needingWarning = await db.job.findMany({
    where: { status: 'PENDING_APPROVAL', completedAt: { lt: warnCutoff } },
    select: { id: true },
    take: 200,
  })

  for (const job of needingWarning) {
    await queue.enqueue(
      'notify.approval-reminder',
      { jobId: job.id },
      // Deduped so a sweep running every ten minutes does not send the same
      // customer the same warning six times an hour.
      { dedupeKey: `approval-reminder:${job.id}` },
    )
  }

  return autoApproveStaleJobs(deps)
}

export async function onSweepExpireJobs(deps: AutomationDeps): Promise<number> {
  const { db, notifier } = deps

  const expiring = await db.job.findMany({
    where: { status: 'POSTED', dueAt: { lt: new Date() } },
    select: { id: true, customerId: true, category: { select: { name: true } } },
    take: 200,
  })

  const expired = await expireUnclaimedJobs(db)

  for (const job of expiring) {
    await notifier.notify({
      userId: job.customerId,
      type: 'JOB_EXPIRING',
      title: 'Your job expired',
      body: `No pro claimed your ${job.category.name} before the deadline. Try posting again at a higher price.`,
      data: { jobId: job.id },
    })
  }

  return expired
}

// ---------------------------------------------------------------------------
// Recomputation
// ---------------------------------------------------------------------------

export async function onRecomputeReputation(deps: AutomationDeps, workerUserId: string): Promise<void> {
  await recalculateReputation(deps.db, workerUserId)
}

export async function onRefreshPremiumFlags(deps: AutomationDeps): Promise<number> {
  return refreshPremiumFlags(deps.db)
}

/**
 * Materializes the leaderboards.
 *
 * Recomputed on a schedule rather than per request: summing every worker's
 * point history on each page load does not survive contact with real traffic,
 * and nobody is harmed by a ranking that is fifteen minutes old.
 */
export async function onRecomputeLeaderboards(deps: AutomationDeps): Promise<number> {
  const { db } = deps
  const now = new Date()

  // Snapped period boundaries, not rolling windows. A rolling start makes the
  // (scope, period, scopeKey, periodStart) key different on every run, so each
  // recomputation creates a brand-new board rather than updating the existing
  // one — 96 duplicate boards a day at a fifteen-minute cadence. It is also
  // wrong as product: a weekly board that never resets is not weekly.
  const periods = (['WEEKLY', 'MONTHLY', 'ALL_TIME'] as const).map((period) => ({
    period,
    ...periodBoundsFor(period, now),
  }))

  let written = 0

  for (const { period, start, end } of periods) {
    const since = start
    for (const scope of ['CITY', 'ROOKIE'] as const) {
      const rows = await db.$queryRaw<Array<{ workerProfileId: string; points: bigint; jobsCompleted: number }>>(Prisma.sql`
        SELECT w."id" AS "workerProfileId",
               COALESCE(SUM(GREATEST(pt."points", 0)), 0)::bigint AS points,
               w."completedJobs" AS "jobsCompleted"
          FROM "worker_profiles" w
          JOIN "users" u ON u."id" = w."userId"
          LEFT JOIN "point_transactions" pt
                 ON pt."workerProfileId" = w."id" AND pt."createdAt" >= ${since}
         WHERE w."status" = 'APPROVED'::"WorkerStatus"
           AND u."status" = 'ACTIVE'::"AccountStatus"
           ${scope === 'ROOKIE' ? Prisma.sql`AND w."completedJobs" < 20` : Prisma.empty}
         GROUP BY w."id", w."completedJobs"
        HAVING COALESCE(SUM(GREATEST(pt."points", 0)), 0) > 0
         ORDER BY points DESC
         LIMIT 250
      `)

      const board = await db.leaderboard.upsert({
        where: {
          scope_period_scopeKey_periodStart: {
            scope, period, scopeKey: scope === 'CITY' ? 'nashville' : 'global', periodStart: start,
          },
        },
        create: {
          scope, period, scopeKey: scope === 'CITY' ? 'nashville' : 'global',
          periodStart: start, periodEnd: end, computedAt: now,
        },
        update: { periodEnd: end, computedAt: now },
      })

      // Replace wholesale: a rank is a position in a full ordering, so
      // upserting rows one by one would leave stale positions behind when
      // someone drops off the board.
      await db.leaderboardEntry.deleteMany({ where: { leaderboardId: board.id } })
      if (rows.length > 0) {
        await db.leaderboardEntry.createMany({
          data: rows.map((row, index) => ({
            leaderboardId: board.id,
            workerProfileId: row.workerProfileId,
            rank: index + 1,
            points: Number(row.points),
            jobsCompleted: row.jobsCompleted,
          })),
        })
        written += rows.length
      }
    }
  }

  return written
}

// ---------------------------------------------------------------------------
// Recurring jobs
// ---------------------------------------------------------------------------

const INTERVAL_DAYS: Record<string, number> = { WEEKLY: 7, BIWEEKLY: 14, MONTHLY: 30 }

/**
 * Generates the next instance of each due recurring service.
 *
 * Recurring conversion is the highest-leverage thing in the product — the same
 * customer converted to biweekly produces roughly thirteen jobs a season
 * instead of one — so this path has to be reliable and must never
 * double-generate.
 */
export async function onGenerateRecurringJobs(deps: AutomationDeps): Promise<number> {
  const { db, queue } = deps
  const now = new Date()

  const due = await db.recurringJob.findMany({
    where: {
      active: true,
      nextRunAt: { lte: now },
      OR: [{ pausedUntil: null }, { pausedUntil: { lt: now } }],
    },
    select: {
      id: true, customerId: true, propertyId: true, categoryId: true,
      interval: true, priceCents: true, specialInstructions: true,
      equipmentProvided: true, nextRunAt: true,
      category: { select: { name: true } },
    },
    take: 200,
  })

  let generated = 0

  for (const recurring of due) {
    // Claim this occurrence by advancing nextRunAt FIRST, guarded on its
    // current value. Two workers running this sweep concurrently cannot both
    // win, so the job is created at most once.
    const advanceTo = new Date(recurring.nextRunAt.getTime() + INTERVAL_DAYS[recurring.interval]! * 86_400_000)
    const claimed = await db.recurringJob.updateMany({
      where: { id: recurring.id, nextRunAt: recurring.nextRunAt },
      data: { nextRunAt: advanceTo, lastRunAt: now },
    })
    if (claimed.count === 0) continue

    const property = await db.$queryRaw<Array<{ lat: number; lng: number; city: string; state: string; yardSize: string }>>(Prisma.sql`
      SELECT ST_Y("location"::geometry) AS lat, ST_X("location"::geometry) AS lng,
             "city", "state", "yardSize"::text AS "yardSize"
        FROM "properties" WHERE "id" = ${recurring.propertyId}
    `)
    const point = property[0]
    if (!point) continue

    const { id: jobId } = await createJob(db, {
      customerId: recurring.customerId,
      propertyId: recurring.propertyId,
      categoryId: recurring.categoryId,
      title: recurring.category.name,
      description: 'Recurring service',
      specialInstructions: recurring.specialInstructions,
      priceCents: recurring.priceCents,
      location: { lat: point.lat, lng: point.lng },
      generalArea: `${point.city}, ${point.state}`,
      // Due at the end of the day it is scheduled for, giving the worker the
      // whole day rather than an arbitrary instant.
      dueAt: new Date(recurring.nextRunAt.getTime() + 86_400_000),
      yardSize: point.yardSize as never,
      equipmentProvided: recurring.equipmentProvided,
      recurringJobId: recurring.id,
      status: 'POSTED',
    })

    await queue.enqueue('notify.job-posted', { jobId }, { dedupeKey: `posted:${jobId}` })
    generated += 1
  }

  return generated
}
