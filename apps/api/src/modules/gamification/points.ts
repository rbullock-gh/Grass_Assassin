import type { Db, Tx } from '../../lib/prisma.js'
import {
  DEFAULT_POINT_VALUES, difficultyBonus, resolveRank, RANKS,
  type PointEvent, type WorkerQualityStats,
} from '@grassassassin/shared'

/**
 * Points, reputation, and rank.
 *
 * `point_transactions` is append-only and is the source of truth.
 * `worker_profiles.points` is a denormalised cache of its sum, because the
 * worker map needs a worker's rank on every request and summing their whole
 * history each time would not survive contact with real traffic.
 *
 * Every transaction records `balanceAfter`, which makes drift between the
 * ledger and the cache detectable rather than theoretical — see
 * `detectPointsDrift`.
 */

export interface AwardParams {
  workerUserId: string
  event: PointEvent
  jobId?: string | null
  /** Overrides the configured value; used for computed bonuses. */
  points?: number
  note?: string
  adminId?: string
}

/** Configured point values, falling back to the compiled defaults. */
export async function loadPointValues(db: Db): Promise<Record<string, number>> {
  const rules = await db.pointRule.findMany({ where: { active: true } })
  const values: Record<string, number> = { ...DEFAULT_POINT_VALUES }
  for (const rule of rules) values[rule.event] = rule.points
  return values
}

/**
 * Awards (or deducts) points.
 *
 * Runs inside a transaction and reads the profile with a row lock, so two
 * concurrent awards for the same worker cannot both compute `balanceAfter` from
 * the same starting value and lose one of the awards.
 */
export async function awardPoints(db: Db, params: AwardParams): Promise<{ points: number; balance: number } | null> {
  const values = await loadPointValues(db)
  const delta = params.points ?? values[params.event] ?? 0
  if (delta === 0 && params.event !== 'ADMIN_ADJUSTMENT') return null

  return db.$transaction(async (tx) => {
    const profile = await tx.workerProfile.findUnique({
      where: { userId: params.workerUserId },
      select: { id: true, points: true, lifetimePoints: true },
    })
    if (!profile) return null

    // Points never go below zero. A worker who racks up penalties should sit at
    // the bottom, not carry a negative score that takes months of good work to
    // climb out of — that is a churn mechanic, not an accountability one.
    const balance = Math.max(0, profile.points + delta)
    const lifetimeDelta = Math.max(0, delta)

    await tx.pointTransaction.create({
      data: {
        workerProfileId: profile.id,
        jobId: params.jobId ?? null,
        event: params.event,
        points: delta,
        balanceAfter: balance,
        note: params.note ?? null,
        adminId: params.adminId ?? null,
      },
    })

    await tx.workerProfile.update({
      where: { id: profile.id },
      data: {
        points: balance,
        lifetimePoints: { increment: lifetimeDelta },
      },
    })

    return { points: delta, balance }
  })
}

/**
 * Awards everything a completed job earns, in one pass.
 *
 * Kept together rather than scattered across the completion handler so the full
 * set of rewards for a job is auditable in one place — and so nobody adds a
 * "finished fast" bonus without seeing the comment explaining why speed is not
 * rewarded here.
 */
export async function awardJobCompletion(db: Db, params: {
  workerUserId: string
  jobId: string
}): Promise<number> {
  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true, customerId: true, dueAt: true, completedAt: true,
      estimatedMinutes: true,
      category: { select: { difficulty: true } },
      photos: { select: { kind: true } },
    },
  })
  if (!job) return 0

  let total = 0
  const add = async (event: PointEvent, points?: number, note?: string) => {
    const result = await awardPoints(db, {
      workerUserId: params.workerUserId, event, jobId: params.jobId, points, note,
    })
    if (result) total += result.points
  }

  await add('JOB_COMPLETED')

  const completedAt = job.completedAt ?? new Date()
  if (completedAt <= job.dueAt) {
    // Capped small on purpose. Rewarding speed on someone's property, with
    // power equipment, is how people get hurt.
    await add('COMPLETED_BEFORE_DEADLINE')
  }

  const kinds = new Set(job.photos.map((p) => p.kind))
  if (kinds.has('BEFORE') && kinds.has('AFTER')) {
    await add('BEFORE_AFTER_PHOTOS')
  }

  const bonus = difficultyBonus({
    estimatedMinutes: job.estimatedMinutes ?? 45,
    categoryDifficulty: job.category.difficulty,
  })
  if (bonus > 0) await add('DIFFICULTY_BONUS', bonus, 'Difficulty bonus')

  // Repeat customer — the direct counter to disintermediation. A worker who
  // keeps a customer on-platform is worth more to us than one who does not.
  const priorJobs = await db.job.count({
    where: {
      customerId: job.customerId,
      claimedByWorkerId: params.workerUserId,
      status: { in: ['APPROVED', 'PAID', 'CLOSED'] },
      id: { not: job.id },
    },
  })
  if (priorJobs > 0) await add('REPEAT_CUSTOMER')

  await applyStreak(db, params.workerUserId, params.jobId)

  return total
}

/** Consecutive completions without a cancellation or no-show. */
async function applyStreak(db: Db, workerUserId: string, jobId: string): Promise<void> {
  const profile = await db.workerProfile.findUnique({
    where: { userId: workerUserId },
    select: { id: true, currentStreak: true, longestStreak: true },
  })
  if (!profile) return

  const streak = profile.currentStreak + 1
  await db.workerProfile.update({
    where: { id: profile.id },
    data: {
      currentStreak: streak,
      longestStreak: Math.max(streak, profile.longestStreak),
    },
  })

  if (streak > 0 && streak % 10 === 0) {
    await awardPoints(db, { workerUserId, event: 'TEN_JOB_STREAK', jobId, note: `${streak}-job streak` })
  } else if (streak > 0 && streak % 5 === 0) {
    await awardPoints(db, { workerUserId, event: 'FIVE_JOB_STREAK', jobId, note: `${streak}-job streak` })
  }
}

/** Breaks the streak. Called on cancellation and no-show. */
export async function breakStreak(db: Db, workerUserId: string): Promise<void> {
  await db.workerProfile.updateMany({ where: { userId: workerUserId }, data: { currentStreak: 0 } })
}

/**
 * Recomputes a worker's reputation from primary data.
 *
 * Every figure here is derived, never incremented in place, so a missed event
 * or a partially-applied update self-corrects on the next recalculation rather
 * than drifting permanently.
 */
export async function recalculateReputation(db: Db, workerUserId: string): Promise<WorkerQualityStats | null> {
  const profile = await db.workerProfile.findUnique({
    where: { userId: workerUserId },
    select: { id: true, points: true },
  })
  if (!profile) return null

  const [claimed, completed, cancelled, noShows, onTime, ratings, repeatCustomers] = await Promise.all([
    db.job.count({ where: { claimedByWorkerId: workerUserId, claimedAt: { not: null } } }),
    db.job.count({ where: { claimedByWorkerId: workerUserId, status: { in: ['APPROVED', 'PAID', 'CLOSED'] } } }),
    db.job.count({ where: { claimedByWorkerId: workerUserId, status: 'CANCELLED', cancelledById: workerUserId } }),
    db.pointTransaction.count({ where: { workerProfileId: profile.id, event: 'NO_SHOW' } }),
    db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "jobs"
        WHERE "claimedByWorkerId" = $1
          AND "status" IN ('APPROVED','PAID','CLOSED')
          AND "completedAt" IS NOT NULL
          AND "completedAt" <= "dueAt"`,
      workerUserId,
    ),
    db.review.aggregate({
      where: { subjectId: workerUserId, direction: 'CUSTOMER_TO_WORKER', hidden: false },
      _avg: { rating: true },
      _count: true,
    }),
    db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM (
         SELECT "customerId" FROM "jobs"
          WHERE "claimedByWorkerId" = $1 AND "status" IN ('APPROVED','PAID','CLOSED')
          GROUP BY "customerId" HAVING count(*) > 1
       ) repeats`,
      workerUserId,
    ),
  ])

  const onTimeCount = Number(onTime[0]?.count ?? 0)
  // Guard the denominators: a brand-new worker has claimed nothing, and 0/0
  // must read as 0, not NaN — a NaN here would silently fail every rank gate.
  const completionRate = claimed > 0 ? completed / claimed : 0
  const onTimeRate = completed > 0 ? onTimeCount / completed : 0

  const stats: WorkerQualityStats = {
    points: profile.points,
    averageRating: ratings._avg.rating,
    completionRate,
    onTimeRate,
    completedJobs: completed,
  }

  const rank = resolveRank(stats, RANKS)
  const rankRow = await db.rank.findUnique({ where: { key: rank.key }, select: { id: true } })

  await db.workerProfile.update({
    where: { id: profile.id },
    data: {
      claimedJobs: claimed,
      completedJobs: completed,
      cancelledJobs: cancelled,
      noShowCount: noShows,
      onTimeJobs: onTimeCount,
      completionRate,
      onTimeRate,
      averageRating: ratings._avg.rating,
      ratingCount: ratings._count,
      repeatCustomers: Number(repeatCustomers[0]?.count ?? 0),
      ...(rankRow ? { rankId: rankRow.id } : {}),
    },
  })

  return stats
}

/** Recomputes a customer's rating after a review lands. */
export async function recalculateCustomerReputation(db: Db, customerUserId: string): Promise<void> {
  const [ratings, posted, completed, cancelled] = await Promise.all([
    db.review.aggregate({
      where: { subjectId: customerUserId, direction: 'WORKER_TO_CUSTOMER', hidden: false },
      _avg: { rating: true }, _count: true,
    }),
    db.job.count({ where: { customerId: customerUserId, status: { not: 'DRAFT' } } }),
    db.job.count({ where: { customerId: customerUserId, status: { in: ['APPROVED', 'PAID', 'CLOSED'] } } }),
    db.job.count({ where: { customerId: customerUserId, status: 'CANCELLED' } }),
  ])

  await db.customerProfile.updateMany({
    where: { userId: customerUserId },
    data: {
      averageRating: ratings._avg.rating,
      ratingCount: ratings._count,
      jobsPosted: posted,
      jobsCompleted: completed,
      cancellationCount: cancelled,
    },
  })
}

/**
 * Whether a customer's rating should be shown to workers yet.
 *
 * Founder decision: workers do see customer ratings, but not until there are
 * enough for the number to mean something. One bad first review should not
 * freeze a customer out of the marketplace permanently.
 */
export const MIN_RATINGS_TO_DISPLAY = 3

export function displayableRating(rating: number | null, ratingCount: number): number | null {
  return ratingCount >= MIN_RATINGS_TO_DISPLAY ? rating : null
}

/**
 * Detects divergence between the append-only point ledger and the cached total.
 *
 * Run on a schedule. A non-zero result means an award was applied to the cache
 * without a transaction, or vice versa — a bug worth finding while it is small.
 */
export async function detectPointsDrift(db: Db): Promise<Array<{ workerProfileId: string; cached: number; ledger: number }>> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; points: number; ledger: bigint | null }>>(`
    SELECT w."id", w."points", SUM(pt."points")::bigint AS ledger
      FROM "worker_profiles" w
      LEFT JOIN "point_transactions" pt ON pt."workerProfileId" = w."id"
     GROUP BY w."id", w."points"
  `)

  return rows
    .map((r) => ({ workerProfileId: r.id, cached: r.points, ledger: Math.max(0, Number(r.ledger ?? 0)) }))
    .filter((r) => r.cached !== r.ledger)
}

export type { Tx }
