import type { RecurringSubscription } from '@grassassassin/client'

/**
 * Describing a standing arrangement to the person paying for it.
 *
 * A recurring job charges somebody on a schedule, so the screen's whole
 * obligation is that they can tell at a glance what is going to happen, when,
 * and for how much — and stop it. Vagueness here is how a subscription becomes
 * a chargeback.
 */

export const INTERVALS = [
  { key: 'WEEKLY', label: 'Every week', days: 7 },
  { key: 'BIWEEKLY', label: 'Every 2 weeks', days: 14 },
  { key: 'MONTHLY', label: 'Every month', days: 30 },
] as const

export type IntervalKey = (typeof INTERVALS)[number]['key']

export function intervalLabel(interval: string): string {
  return INTERVALS.find((i) => i.key === interval)?.label ?? interval
}

export type ScheduleState = 'active' | 'paused' | 'cancelled'

export function scheduleState(
  subscription: Pick<RecurringSubscription, 'active' | 'pausedUntil'>,
  now: Date = new Date(),
): ScheduleState {
  if (!subscription.active) return 'cancelled'
  if (subscription.pausedUntil && new Date(subscription.pausedUntil) > now) return 'paused'
  return 'active'
}

/**
 * The one line that matters: what happens next, and when.
 *
 * Written so that somebody scanning the screen can answer "am I about to be
 * charged" without opening anything. A cancelled schedule says so plainly
 * rather than showing a next date that will never arrive.
 */
export function nextRunSentence(
  subscription: Pick<RecurringSubscription, 'active' | 'pausedUntil' | 'nextRunAt' | 'priceCents'>,
  now: Date = new Date(),
): string {
  const state = scheduleState(subscription, now)
  const money = `$${(subscription.priceCents / 100).toFixed(2)}`

  if (state === 'cancelled') return 'Cancelled. Nothing more will be booked.'

  if (state === 'paused') {
    const until = new Date(subscription.pausedUntil as string)
    return `Paused until ${dayLabel(until)}. Nothing is booked before then.`
  }

  const next = new Date(subscription.nextRunAt)
  if (Number.isNaN(next.getTime())) return `Next job ${money}.`

  const days = Math.round((startOfDay(next).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (days <= 0) return `Next job is being posted today, ${money}.`
  if (days === 1) return `Next job posts tomorrow, ${money}.`
  if (days <= 14) return `Next job posts in ${days} days, ${money}.`
  return `Next job posts ${dayLabel(next)}, ${money}.`
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * How long a pause should last, offered as choices rather than a date picker.
 *
 * The real reasons somebody pauses a lawn service are a holiday, a dry spell,
 * or winter. A calendar makes them do arithmetic to express any of those.
 */
export const PAUSE_OPTIONS = [
  { key: '2w', label: 'For 2 weeks', days: 14 },
  { key: '1m', label: 'For a month', days: 30 },
  { key: '3m', label: 'For 3 months', days: 90 },
] as const

export function pauseUntil(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}

/** What cancelling actually does, said before they do it. */
export function cancelConsequence(subscription: Pick<RecurringSubscription, 'nextRunAt'>): string {
  return 'No more jobs will be booked on this schedule. Any job already posted '
    + 'stays as it is, and you can set the service up again whenever you want.'
}
