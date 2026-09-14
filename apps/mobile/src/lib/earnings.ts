import {
  RANKS, nextRank, progressToNextRank as pointsProgress,
  type RankDefinition,
} from '@grassassassin/shared'

/**
 * Earnings and rank display logic.
 *
 * Pure, and separate from the screen, because the wording here is a product
 * decision with money attached: a worker who cannot tell why their balance is
 * lower than what they earned assumes the platform is skimming.
 */

/**
 * What a payout is actually doing right now.
 *
 * Deliberately never says "failed" without saying what happens next. A worker
 * reading "failed" with no follow-up assumes the money is gone.
 */
export function payoutStatusLabel(status: string, arrivalDate: string | null): string {
  const arrival = arrivalDate ? new Date(arrivalDate) : null
  const arrivalText = arrival && !Number.isNaN(arrival.getTime())
    ? arrival.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  switch (status) {
    case 'PENDING':
    case 'IN_TRANSIT':
      return arrivalText ? `On its way — arrives ${arrivalText}` : 'On its way to your bank'
    case 'PAID':
      return arrivalText ? `Paid ${arrivalText}` : 'Paid'
    case 'FAILED':
      return 'Your bank rejected this. Check your account details — the money is still yours.'
    case 'CANCELED':
    case 'CANCELLED':
      return 'Cancelled. The money went back to your available balance.'
    default:
      return status.toLowerCase().replace(/_/g, ' ')
  }
}

export interface RankProgress {
  currentKey: string
  currentName: string
  nextName: string | null
  pointsRemaining: number
  /** 0..1, for the progress bar. */
  fraction: number
  /** The next rank has quality gates beyond points. */
  gated: boolean
  /** Plain-language summary of those gates, e.g. "keep a 4.2★ rating". */
  gateHint: string
}

/**
 * Progress toward the next rank, including what points alone will not buy.
 *
 * Showing only a points bar would be a lie of omission: a worker can hit 1,500
 * points and still not be a Lawn Ranger because the rank also requires a 4.2
 * rating. Someone who discovers that at the finish line concludes the ladder is
 * rigged — so the requirement is stated the whole way up.
 */
export function progressToNextRank(
  points: number,
  currentKey: string | null,
  ranks: readonly RankDefinition[] = RANKS,
): RankProgress | null {
  const current = ranks.find((rank) => rank.key === currentKey)
    ?? ranks.find((rank) => rank.key === 'ROOKIE')
    ?? ranks[0]
  if (!current) return null

  const next = nextRank(current, ranks)
  const progress = pointsProgress(points, current, ranks)

  return {
    currentKey: current.key,
    currentName: current.name,
    nextName: next?.name ?? null,
    pointsRemaining: progress?.pointsNeeded ?? 0,
    fraction: progress?.fraction ?? 1,
    gated: next ? hasGates(next) : false,
    gateHint: next ? gateHint(next) : '',
  }
}

function hasGates(rank: RankDefinition): boolean {
  return rank.minRating !== null || rank.minCompletionRate !== null || rank.minOnTimeRate !== null
}

function gateHint(rank: RankDefinition): string {
  const parts: string[] = []
  if (rank.minRating !== null) parts.push(`a ${rank.minRating.toFixed(1)}★ rating`)
  if (rank.minCompletionRate !== null) parts.push(`${Math.round(rank.minCompletionRate * 100)}% completion`)
  if (rank.minOnTimeRate !== null) parts.push(`${Math.round(rank.minOnTimeRate * 100)}% on time`)

  if (parts.length === 0) return ''
  if (parts.length === 1) return `keep ${parts[0]}`
  const last = parts.pop()!
  return `keep ${parts.join(', ')} and ${last}`
}
