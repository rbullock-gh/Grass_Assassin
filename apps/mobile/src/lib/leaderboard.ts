import type { Leaderboard } from '@grassassassin/client'

/**
 * What to tell a worker about the board they are looking at.
 *
 * Two questions a leaderboard has to answer honestly and usually does not:
 * which period is this, and how old are these numbers. A worker who just
 * finished a job and does not see their points move concludes the app lost
 * them — unless the screen says when it last counted.
 */

/** "This week", as the dates the server actually used. */
export function describePeriod(board: Pick<Leaderboard, 'period' | 'periodStart' | 'periodEnd'>): string {
  const start = new Date(board.periodStart)
  if (Number.isNaN(start.getTime())) return ''

  const day = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  switch (board.period) {
    case 'WEEKLY': {
      const end = new Date(new Date(board.periodEnd).getTime() - 86_400_000)
      return Number.isNaN(end.getTime()) ? '' : `${day(start)} – ${day(end)}`
    }
    case 'MONTHLY':
      return start.toLocaleDateString(undefined, { month: 'long' })
    default:
      return 'Since the beginning'
  }
}

/**
 * How fresh the standings are.
 *
 * A null computedAt means the server worked them out for this request, so they
 * are current — that is worth saying plainly rather than leaving blank, because
 * blank reads as unknown.
 */
export function describeFreshness(
  computedAt: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!computedAt) return 'Up to date'

  const at = new Date(computedAt)
  if (Number.isNaN(at.getTime())) return 'Up to date'

  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes <= 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  return `Updated ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/**
 * Why the board on screen is not the one that was tapped.
 *
 * Returns null when nothing fell back. The whole point of surfacing this is
 * that showing the city board under a "Near me" heading is the bug this fix
 * exists to remove; swapping a silent lie for a quiet one would be no better.
 */
export function describeFallback(board: Pick<Leaderboard, 'fellBackFrom' | 'scope'>): string | null {
  if (!board.fellBackFrom) return null
  if (board.fellBackFrom === 'LOCAL') {
    return 'Showing the city board — set your home base in setup to see pros near you.'
  }
  return null
}
