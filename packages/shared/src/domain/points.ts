/**
 * GrassPoints, ranks, and the safeguards that keep gamification from producing
 * the wrong behavior.
 *
 * Two rules govern everything in this file (see docs/00-strategy.md §6):
 *
 *  1. Points reward reliability and quality, never raw speed. No rule here pays
 *     a worker for finishing faster in a way that would encourage rushing on
 *     someone's property with power equipment.
 *
 *  2. Declining a job costs nothing, ever. Beyond being correct product design,
 *     penalizing declines is direct evidence of employment-style control and is
 *     a live misclassification risk (strategy R2).
 *
 * Point values and rank thresholds are seeded into `point_rules` / `ranks` and are
 * editable from the admin dashboard. These constants are defaults only.
 */

export const POINT_EVENTS = [
  'JOB_COMPLETED',
  'COMPLETED_BEFORE_DEADLINE',
  'FIVE_STAR_REVIEW',
  'BEFORE_AFTER_PHOTOS',
  'FAST_CUSTOMER_RESPONSE',
  'FIVE_JOB_STREAK',
  'TEN_JOB_STREAK',
  'DIFFICULTY_BONUS',
  'REPEAT_CUSTOMER',
  'CANCEL_AFTER_CLAIM_EARLY',
  'CANCEL_AFTER_CLAIM_LATE',
  'NO_SHOW',
  'LATE_WITHOUT_COMMUNICATION',
  'VERIFIED_COMPLAINT',
  'ADMIN_ADJUSTMENT',
] as const

export type PointEvent = (typeof POINT_EVENTS)[number]

export const DEFAULT_POINT_VALUES: Record<PointEvent, number> = {
  JOB_COMPLETED: 100,
  COMPLETED_BEFORE_DEADLINE: 25,
  FIVE_STAR_REVIEW: 20,
  BEFORE_AFTER_PHOTOS: 10,
  FAST_CUSTOMER_RESPONSE: 10,
  FIVE_JOB_STREAK: 50,
  TEN_JOB_STREAK: 100,
  DIFFICULTY_BONUS: 0, // computed per job, see difficultyBonus()
  REPEAT_CUSTOMER: 40,
  CANCEL_AFTER_CLAIM_EARLY: -50,
  CANCEL_AFTER_CLAIM_LATE: -150,
  NO_SHOW: -300,
  LATE_WITHOUT_COMMUNICATION: -75,
  VERIFIED_COMPLAINT: -200,
  ADMIN_ADJUSTMENT: 0,
}

/** Difficulty bonus scales with effort, capped so it cannot dominate quality signals. */
export function difficultyBonus(params: {
  /** Estimated minutes of work. */
  estimatedMinutes: number
  /** 1 (easy) .. 5 (hard), from the job category. */
  categoryDifficulty: number
}): number {
  const { estimatedMinutes, categoryDifficulty } = params
  const timeComponent = Math.min(45, Math.floor(estimatedMinutes / 20) * 5)
  const difficultyComponent = Math.max(0, (categoryDifficulty - 1) * 7.5)
  return Math.min(75, Math.round(timeComponent + difficultyComponent))
}

export interface RankDefinition {
  key: string
  name: string
  minPoints: number
  /** Commission discount in basis points, applied against the base rate. */
  commissionDiscountBps: number
  /** Additional service radius, miles. */
  radiusBonusMiles: number
  /** Minutes of early access to premium jobs. 0 = none. */
  earlyAccessMinutes: number
  verifiedBadge: boolean
  /**
   * Quality gates. Points alone never buy rank — a high-volume, low-quality
   * worker stalls below these tiers. Evaluated over a rolling window.
   */
  minRating: number | null
  minCompletionRate: number | null
  minOnTimeRate: number | null
}

export const RANKS: readonly RankDefinition[] = [
  {
    key: 'ROOKIE', name: 'Rookie', minPoints: 0,
    commissionDiscountBps: 0, radiusBonusMiles: 0, earlyAccessMinutes: 0,
    verifiedBadge: false, minRating: null, minCompletionRate: null, minOnTimeRate: null,
  },
  {
    key: 'TRIMMER', name: 'Trimmer', minPoints: 500,
    commissionDiscountBps: 0, radiusBonusMiles: 2, earlyAccessMinutes: 0,
    verifiedBadge: false, minRating: null, minCompletionRate: 0.8, minOnTimeRate: null,
  },
  {
    key: 'LAWN_RANGER', name: 'Lawn Ranger', minPoints: 1500,
    commissionDiscountBps: 0, radiusBonusMiles: 5, earlyAccessMinutes: 0,
    verifiedBadge: true, minRating: 4.2, minCompletionRate: 0.85, minOnTimeRate: 0.8,
  },
  {
    key: 'YARD_HUNTER', name: 'Yard Hunter', minPoints: 4000,
    commissionDiscountBps: 100, radiusBonusMiles: 7, earlyAccessMinutes: 0,
    verifiedBadge: true, minRating: 4.4, minCompletionRate: 0.9, minOnTimeRate: 0.85,
  },
  {
    key: 'GRASS_ASSASSIN', name: 'Grass Assassin', minPoints: 10_000,
    commissionDiscountBps: 200, radiusBonusMiles: 10, earlyAccessMinutes: 0,
    verifiedBadge: true, minRating: 4.6, minCompletionRate: 0.95, minOnTimeRate: 0.9,
  },
  {
    key: 'ELITE_ASSASSIN', name: 'Elite Assassin', minPoints: 25_000,
    commissionDiscountBps: 300, radiusBonusMiles: 12, earlyAccessMinutes: 10,
    verifiedBadge: true, minRating: 4.7, minCompletionRate: 0.95, minOnTimeRate: 0.92,
  },
  {
    key: 'LEGEND', name: 'Legend', minPoints: 60_000,
    commissionDiscountBps: 400, radiusBonusMiles: 15, earlyAccessMinutes: 10,
    verifiedBadge: true, minRating: 4.8, minCompletionRate: 0.96, minOnTimeRate: 0.94,
  },
] as const

export interface WorkerQualityStats {
  points: number
  /** Null when the worker has too few ratings to compute one. */
  averageRating: number | null
  completionRate: number
  onTimeRate: number
  completedJobs: number
}

/**
 * Resolves a worker's rank from points *and* quality.
 *
 * Walks down from the highest rank the worker's points would allow and returns the
 * first whose quality gates they actually satisfy. This is what stops the
 * "1,200 mediocre jobs" path to the top of the leaderboard.
 */
export function resolveRank(stats: WorkerQualityStats, ranks: readonly RankDefinition[] = RANKS): RankDefinition {
  const byPointsDesc = [...ranks].sort((a, b) => b.minPoints - a.minPoints)

  for (const rank of byPointsDesc) {
    if (stats.points < rank.minPoints) continue
    if (rank.minRating !== null && (stats.averageRating ?? 0) < rank.minRating) continue
    if (rank.minCompletionRate !== null && stats.completionRate < rank.minCompletionRate) continue
    if (rank.minOnTimeRate !== null && stats.onTimeRate < rank.minOnTimeRate) continue
    return rank
  }

  // ROOKIE has no gates, so this is unreachable with the default table; the
  // fallback exists so a misconfigured admin rank table cannot throw at runtime.
  return byPointsDesc[byPointsDesc.length - 1] ?? RANKS[0]!
}

export function nextRank(current: RankDefinition, ranks: readonly RankDefinition[] = RANKS): RankDefinition | null {
  return (
    [...ranks].sort((a, b) => a.minPoints - b.minPoints).find((r) => r.minPoints > current.minPoints) ?? null
  )
}

export function progressToNextRank(
  points: number,
  current: RankDefinition,
  ranks: readonly RankDefinition[] = RANKS,
): { pointsNeeded: number; fraction: number } | null {
  const next = nextRank(current, ranks)
  if (!next) return null
  const span = next.minPoints - current.minPoints
  const earned = Math.max(0, points - current.minPoints)
  return {
    pointsNeeded: Math.max(0, next.minPoints - points),
    fraction: span <= 0 ? 1 : Math.min(1, earned / span),
  }
}

/** Newcomers are exempt from early-access delays entirely for their first N jobs. */
export const NEW_WORKER_EARLY_ACCESS_EXEMPT_JOBS = 10

/**
 * Decides whether a worker may see a premium job during its early-access window.
 *
 * Ordinary jobs are never gated — this is only consulted for the top-quartile-payout
 * jobs, for a 10-minute window, and it always returns true for new workers.
 */
export function canSeeDuringEarlyAccess(params: {
  isPremiumJob: boolean
  secondsSincePosted: number
  rank: RankDefinition
  completedJobs: number
}): boolean {
  const { isPremiumJob, secondsSincePosted, rank, completedJobs } = params
  if (!isPremiumJob) return true
  if (completedJobs < NEW_WORKER_EARLY_ACCESS_EXEMPT_JOBS) return true

  const maxWindowSeconds = Math.max(...RANKS.map((r) => r.earlyAccessMinutes)) * 60
  if (secondsSincePosted >= maxWindowSeconds) return true

  const workerUnlockSeconds = maxWindowSeconds - rank.earlyAccessMinutes * 60
  return secondsSincePosted >= workerUnlockSeconds
}

/** Rookie bracket keeps newcomers off a board they cannot win. */
export const ROOKIE_BRACKET_MAX_JOBS = 20

export type LeaderboardScope = 'LOCAL' | 'CITY' | 'ROOKIE'
export type LeaderboardPeriod = 'WEEKLY' | 'MONTHLY' | 'ALL_TIME'
