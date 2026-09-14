import type { MapJob } from '@grassassassin/client'
import { formatDistance, metersToMiles } from '@grassassassin/shared'

/**
 * Client-side presentation logic for jobs.
 *
 * Sorting and filtering also happen server-side; these exist so the list
 * re-orders instantly when a worker changes a sort chip, without a round trip
 * that would make the UI feel laggy on a phone signal. The server remains
 * authoritative — this only reorders what it already returned.
 */

export type SortKey = 'DISTANCE' | 'PAY_DESC' | 'NEWEST' | 'DUE_SOON' | 'PAY_PER_HOUR'

export interface Filters {
  maxDistanceMiles?: number
  minPayoutCents?: number
  categoryIds?: string[]
  equipmentProvided?: boolean
  difficulty?: 'EASY' | 'MODERATE' | 'HARD'
  dueToday?: boolean
  dueThisWeek?: boolean
}

export const EMPTY_FILTERS: Filters = {}

export function countActiveFilters(filters: Filters): number {
  let count = 0
  if (filters.maxDistanceMiles !== undefined) count += 1
  if (filters.minPayoutCents !== undefined) count += 1
  if (filters.categoryIds?.length) count += 1
  if (filters.equipmentProvided !== undefined) count += 1
  if (filters.difficulty !== undefined) count += 1
  if (filters.dueToday) count += 1
  if (filters.dueThisWeek) count += 1
  return count
}

/**
 * Preset values offered in the filter sheet.
 *
 * Presets, not sliders. A slider on a phone is a precision task done with a
 * thumb, in the sun, often in a truck — and nobody genuinely wants "$43
 * minimum". Five taps that cover the real decisions beat one gesture that
 * covers all of them badly.
 */
export const DISTANCE_PRESETS_MILES = [3, 5, 10, 20, 30] as const
export const MIN_PAYOUT_PRESETS_CENTS = [2000, 3500, 5000, 7500, 10_000] as const
export const DIFFICULTY_LABELS: Record<'EASY' | 'MODERATE' | 'HARD', string> = {
  EASY: 'Easy',
  MODERATE: 'Moderate',
  HARD: 'Hard',
}

/**
 * Toggling a filter off by re-tapping the value that is already set.
 *
 * Without this a worker who taps "10 miles" by accident has no way back to
 * "any distance" except Clear All, which throws away the four filters they
 * meant to keep.
 */
export function toggleFilterValue<K extends keyof Filters>(
  filters: Filters,
  key: K,
  value: NonNullable<Filters[K]>,
): Filters {
  const next = { ...filters }
  if (next[key] === value) delete next[key]
  else next[key] = value
  return next
}

/** Category filters are multi-select, so they toggle within a list. */
export function toggleCategory(filters: Filters, categoryId: string): Filters {
  const current = filters.categoryIds ?? []
  const next = current.includes(categoryId)
    ? current.filter((id) => id !== categoryId)
    : [...current, categoryId]
  const result = { ...filters }
  if (next.length === 0) delete result.categoryIds
  else result.categoryIds = next
  return result
}

/**
 * "Today" and "this week" are one question, not two.
 *
 * Both set at once is a contradiction the worker cannot see and would read as
 * a broken filter, so choosing one clears the other.
 */
export function setDeadlineFilter(filters: Filters, choice: 'TODAY' | 'THIS_WEEK' | null): Filters {
  const next = { ...filters }
  delete next.dueToday
  delete next.dueThisWeek
  if (choice === 'TODAY') next.dueToday = true
  if (choice === 'THIS_WEEK') next.dueThisWeek = true
  return next
}

export function deadlineFilterOf(filters: Filters): 'TODAY' | 'THIS_WEEK' | null {
  if (filters.dueToday) return 'TODAY'
  if (filters.dueThisWeek) return 'THIS_WEEK'
  return null
}

/**
 * One line describing what is currently filtered.
 *
 * Shown on the collapsed control so a worker seeing three jobs where there
 * were forty knows why, without opening the sheet to find out.
 */
export function describeFilters(filters: Filters, categoryNames: Record<string, string> = {}): string {
  const parts: string[] = []
  if (filters.maxDistanceMiles !== undefined) parts.push(`within ${filters.maxDistanceMiles} mi`)
  if (filters.minPayoutCents !== undefined) parts.push(`${displayPayout(filters.minPayoutCents)}+`)
  if (filters.categoryIds?.length) {
    const named = filters.categoryIds.map((id) => categoryNames[id]).filter(Boolean) as string[]
    parts.push(named.length > 0 && named.length === filters.categoryIds.length
      ? named.join(', ')
      : `${filters.categoryIds.length} categories`)
  }
  if (filters.difficulty !== undefined) parts.push(DIFFICULTY_LABELS[filters.difficulty].toLowerCase())
  if (filters.equipmentProvided !== undefined) {
    parts.push(filters.equipmentProvided ? 'gear provided' : 'own gear')
  }
  if (filters.dueToday) parts.push('due today')
  else if (filters.dueThisWeek) parts.push('due this week')

  return parts.length === 0 ? 'All jobs' : parts.join(' · ')
}

export function applyFilters(jobs: MapJob[], filters: Filters, now = new Date()): MapJob[] {
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)
  const endOfWeek = new Date(now.getTime() + 7 * 86_400_000)

  return jobs.filter((job) => {
    if (filters.maxDistanceMiles !== undefined && metersToMiles(job.distanceMeters) > filters.maxDistanceMiles) return false
    if (filters.minPayoutCents !== undefined && job.workerPayoutCents < filters.minPayoutCents) return false
    if (filters.categoryIds?.length && !filters.categoryIds.includes(job.categoryId)) return false
    if (filters.equipmentProvided !== undefined && job.equipmentProvided !== filters.equipmentProvided) return false
    if (filters.difficulty !== undefined && job.difficulty !== filters.difficulty) return false
    if (filters.dueToday && new Date(job.dueAt) > endOfToday) return false
    if (filters.dueThisWeek && new Date(job.dueAt) > endOfWeek) return false
    return true
  })
}

export function sortJobs(jobs: MapJob[], sort: SortKey): MapJob[] {
  const sorted = [...jobs]

  // Featured jobs lead every ordering. That buys position only — a featured job
  // never hides another, and never changes who is allowed to claim.
  const featuredFirst = (a: MapJob, b: MapJob) => Number(b.isFeatured) - Number(a.isFeatured)

  switch (sort) {
    case 'PAY_DESC':
      return sorted.sort((a, b) => featuredFirst(a, b) || b.workerPayoutCents - a.workerPayoutCents)
    case 'NEWEST':
      return sorted.sort((a, b) => featuredFirst(a, b) || new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    case 'DUE_SOON':
      return sorted.sort((a, b) => featuredFirst(a, b) || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    case 'PAY_PER_HOUR':
      // Jobs with no estimate sort last rather than appearing infinitely
      // valuable, which is what a naive null-as-zero comparison would do.
      return sorted.sort((a, b) => {
        const featured = featuredFirst(a, b)
        if (featured !== 0) return featured
        const aRate = a.payPerHourCents
        const bRate = b.payPerHourCents
        if (aRate === null && bRate === null) return a.distanceMeters - b.distanceMeters
        if (aRate === null) return 1
        if (bRate === null) return -1
        return bRate - aRate
      })
    case 'DISTANCE':
    default:
      return sorted.sort((a, b) => featuredFirst(a, b) || a.distanceMeters - b.distanceMeters)
  }
}

export const SORT_LABELS: Record<SortKey, string> = {
  DISTANCE: 'Closest',
  PAY_DESC: 'Highest pay',
  NEWEST: 'Newest',
  DUE_SOON: 'Due soon',
  PAY_PER_HOUR: 'Best $/hr',
}

/** Whole dollars on markers and cards — cents are noise at a glance. */
/**
 * A job's price, for a map marker or a card.
 *
 * Rounded to whole dollars because a marker is read at a glance from arm's
 * length and ".00" on every one of forty pins is noise. Job prices are set in
 * whole dollars, so nothing is actually lost here.
 *
 * NEVER use this for a balance. See displayMoney.
 */
export function displayPrice(cents: number): string {
  return `$${Math.round(cents / 100)}`
}

/**
 * An exact amount of money, for anywhere it is somebody's balance.
 *
 * displayPrice ROUNDS, which on a bank balance is a lie in whichever direction
 * it lands: $3,527.60 available renders as "$3,528" and shows a worker more
 * money than they have. Money that belongs to someone gets every cent and a
 * thousands separator.
 */
export function displayMoney(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100).toLocaleString('en-US')
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`
}

export function displayPayout(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function displayRate(payPerHourCents: number | null): string | null {
  return payPerHourCents === null ? null : `$${Math.round(payPerHourCents / 100)}/hr`
}

export { formatDistance }

/**
 * Human deadline, phrased the way a worker thinks about it.
 *
 * "Due today by 7 PM" is actionable; "2026-09-14T19:00:00Z" is not.
 */
export function formatDeadline(dueAt: string | Date, now = new Date()): string {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: due.getMinutes() ? '2-digit' : undefined })

  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0)
  const dayDelta = Math.floor((due.getTime() - startOfToday.getTime()) / 86_400_000)

  if (due < now) return 'Overdue'
  if (dayDelta === 0) return `Today by ${time}`
  if (dayDelta === 1) return `Tomorrow by ${time}`
  if (dayDelta < 7) return `${due.toLocaleDateString('en-US', { weekday: 'long' })} by ${time}`
  return due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Under six hours reads as urgent, and the marker turns red. */
export function isUrgent(dueAt: string | Date, now = new Date()): boolean {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  const hours = (due.getTime() - now.getTime()) / 3_600_000
  return hours > 0 && hours <= 6
}

export type MarkerVariant = 'default' | 'premium' | 'featured' | 'urgent'

export function markerVariantFor(job: MapJob, now = new Date()): MarkerVariant {
  // Order matters: urgency is a deadline signal the worker must not miss, so it
  // outranks the commercial signals.
  if (isUrgent(job.dueAt, now)) return 'urgent'
  if (job.isFeatured) return 'featured'
  if (job.isPremium) return 'premium'
  return 'default'
}

export function yardSizeLabel(yardSize: string | null): string | null {
  switch (yardSize) {
    case 'UNDER_QUARTER_ACRE': return 'Under ¼ acre'
    case 'QUARTER_TO_HALF': return '¼–½ acre'
    case 'HALF_TO_ONE': return '½–1 acre'
    case 'ONE_TO_TWO': return '1–2 acres'
    case 'OVER_TWO': return '2+ acres'
    default: return null
  }
}
