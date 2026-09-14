/**
 * Leaderboard period boundaries.
 *
 * A weekly board must be a FIXED window that resets, not a rolling seven days.
 * Two reasons, one product and one structural:
 *
 *   · Product: a resetting board is what makes a weekly leaderboard
 *     motivating. On a rolling window a worker's rank drifts for reasons they
 *     did not cause, and there is never a moment where anyone "wins".
 *
 *   · Structural: boards are keyed by (scope, period, scopeKey, periodStart).
 *     With a rolling start, that key is different on every recomputation, so
 *     each run creates a brand-new board instead of updating the existing one —
 *     at a fifteen-minute cadence that is 96 duplicate boards a day.
 *
 * Weeks start Monday, which is the ISO convention and matches how people talk
 * about a working week.
 */

export type LeaderboardPeriodKey = 'WEEKLY' | 'MONTHLY' | 'ALL_TIME'

export interface PeriodBounds {
  start: Date
  end: Date
}

/** UTC midnight on the Monday of the week containing `now`. */
export function startOfIsoWeek(now: Date): Date {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  // getUTCDay() is 0 for Sunday; shift so Monday is 0.
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  return date
}

export function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export function periodBoundsFor(period: LeaderboardPeriodKey, now: Date): PeriodBounds {
  switch (period) {
    case 'WEEKLY': {
      const start = startOfIsoWeek(now)
      return { start, end: new Date(start.getTime() + 7 * 86_400_000) }
    }
    case 'MONTHLY': {
      const start = startOfMonth(now)
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
      return { start, end }
    }
    case 'ALL_TIME':
    default:
      return { start: new Date(0), end: new Date(Date.UTC(9999, 0, 1)) }
  }
}
