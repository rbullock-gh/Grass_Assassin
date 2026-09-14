import { db } from './db'

/**
 * Dashboard metrics.
 *
 * Every figure here is computed from primary data rather than a counter, so the
 * dashboard cannot drift away from reality the way an incremented stat would.
 * At scale several of these become materialised views refreshed on a schedule;
 * at launch volume they are fast enough as direct queries, and correctness while
 * the numbers are small matters more than speed.
 */

export interface Metrics {
  jobsPosted: number
  jobsCompleted: number
  jobsOpen: number
  grossMarketplaceVolumeCents: number
  platformRevenueCents: number
  activeWorkers: number
  activeCustomers: number
  averageJobPriceCents: number
  averageMinutesToClaim: number | null
  claimRate: number
  completionRate: number
  disputeRate: number
  ledgerDeltaCents: number
}

export async function loadMetrics(): Promise<Metrics> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)
  const terminalPaid = ['APPROVED', 'PAID', 'CLOSED'] as const

  const [
    jobsPosted, jobsCompleted, jobsOpen, volume, revenue,
    activeWorkers, activeCustomers, claimTimes, everClaimed, disputes, ledger,
  ] = await Promise.all([
    db.job.count({ where: { status: { not: 'DRAFT' } } }),
    db.job.count({ where: { status: { in: [...terminalPaid] } } }),
    db.job.count({ where: { status: 'POSTED' } }),
    db.job.aggregate({
      where: { status: { in: [...terminalPaid] } },
      _sum: { priceCents: true },
      _avg: { priceCents: true },
    }),
    db.ledgerEntry.aggregate({
      where: { account: 'platform:revenue' },
      _sum: { amountCents: true },
    }),
    db.workerProfile.count({ where: { status: 'APPROVED' } }),
    db.user.count({ where: { status: 'ACTIVE', customerProfile: { isNot: null } } }),
    db.$queryRaw<Array<{ avg: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM ("claimedAt" - "postedAt")) / 60)::float8 AS avg
        FROM "jobs"
       WHERE "claimedAt" IS NOT NULL AND "postedAt" IS NOT NULL
         AND "postedAt" >= ${thirtyDaysAgo}
    `,
    db.job.count({ where: { claimedAt: { not: null } } }),
    db.job.count({ where: { status: 'DISPUTED' } }),
    db.ledgerEntry.aggregate({ _sum: { amountCents: true } }),
  ])

  const postedEver = jobsPosted || 1

  return {
    jobsPosted,
    jobsCompleted,
    jobsOpen,
    grossMarketplaceVolumeCents: volume._sum.priceCents ?? 0,
    platformRevenueCents: revenue._sum.amountCents ?? 0,
    activeWorkers,
    activeCustomers,
    averageJobPriceCents: Math.round(volume._avg.priceCents ?? 0),
    averageMinutesToClaim: claimTimes[0]?.avg ?? null,
    claimRate: everClaimed / postedEver,
    completionRate: jobsCompleted / postedEver,
    disputeRate: disputes / postedEver,
    // The invariant: every cent in the ledger must net to zero. A non-zero
    // value here is a page-someone-now event, so it is on the dashboard rather
    // than buried in a report nobody opens.
    ledgerDeltaCents: ledger._sum.amountCents ?? 0,
  }
}

export async function loadRecentJobs(limit = 12) {
  return db.job.findMany({
    where: { status: { not: 'DRAFT' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, title: true, status: true, priceCents: true, workerPayoutCents: true,
      generalArea: true, createdAt: true, claimedAt: true, postedAt: true, dueAt: true,
      category: { select: { name: true } },
      customer: { select: { firstName: true } },
    },
  })
}

export async function loadTopWorkers(limit = 8) {
  return db.workerProfile.findMany({
    where: { status: 'APPROVED' },
    orderBy: { points: 'desc' },
    take: limit,
    select: {
      id: true, points: true, completedJobs: true, averageRating: true,
      completionRate: true, onTimeRate: true, lifetimeEarningsCents: true,
      user: { select: { firstName: true, lastName: true } },
      rank: { select: { name: true, key: true } },
    },
  })
}

/** Jobs posted per day, for the trend chart. */
export async function loadJobTrend(days = 14) {
  const rows = await db.$queryRaw<Array<{ day: Date; posted: bigint; completed: bigint }>>`
    SELECT d::date AS day,
           COUNT(j."id") FILTER (WHERE j."postedAt"::date = d::date)::bigint AS posted,
           COUNT(j."id") FILTER (WHERE j."completedAt"::date = d::date)::bigint AS completed
      FROM generate_series(
             (CURRENT_DATE - (${days - 1} || ' days')::interval)::date,
             CURRENT_DATE::date,
             '1 day'
           ) d
      LEFT JOIN "jobs" j
             ON j."postedAt"::date = d::date OR j."completedAt"::date = d::date
     GROUP BY d
     ORDER BY d ASC
  `
  return rows.map((r) => ({
    day: r.day,
    posted: Number(r.posted),
    completed: Number(r.completed),
  }))
}

export async function loadTrialBalance() {
  const rows = await db.ledgerEntry.groupBy({
    by: ['account'],
    _sum: { amountCents: true },
    orderBy: { account: 'asc' },
  })
  return rows.map((r) => ({ account: r.account, balanceCents: r._sum.amountCents ?? 0 }))
}

export async function loadFeeConfig() {
  return db.platformConfig.findMany({ orderBy: [{ scopeKey: 'asc' }, { key: 'asc' }] })
}
