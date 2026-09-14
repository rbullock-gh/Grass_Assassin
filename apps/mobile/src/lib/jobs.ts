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
export function displayPrice(cents: number): string {
  return `$${Math.round(cents / 100)}`
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
