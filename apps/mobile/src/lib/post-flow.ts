import type { Category, PriceGuidance } from '@grassassassin/client'

/**
 * The five-step job posting flow.
 *
 * Kept as a pure state machine, free of React and React Native, for two
 * reasons: it is the highest-drop-off funnel in the product and therefore the
 * thing most worth testing exhaustively, and the same logic drives the web
 * client where there is no React Native at all.
 *
 * Step order is deliberate (docs/02-flows-and-screens.md §1): the customer
 * picks WHAT first because it is the easiest question and commits them, and
 * PRICE comes last because it is the one that makes people hesitate. Asking for
 * money before they have invested any effort is how a funnel dies.
 */

export const POST_STEPS = ['WHAT', 'WHERE', 'WHEN', 'HOW', 'PRICE'] as const
export type PostStep = (typeof POST_STEPS)[number]

export type YardSize = 'UNDER_QUARTER_ACRE' | 'QUARTER_TO_HALF' | 'HALF_TO_ONE' | 'ONE_TO_TWO' | 'OVER_TWO'

export interface PostDraft {
  categoryId: string | null
  description: string
  photoIds: string[]
  propertyId: string | null
  dueAt: Date | null
  windowStartAt: Date | null
  windowEndAt: Date | null
  yardSize: YardSize | null
  equipmentProvided: boolean
  specialInstructions: string
  priceCents: number | null
}

export const EMPTY_DRAFT: PostDraft = {
  categoryId: null,
  description: '',
  photoIds: [],
  propertyId: null,
  dueAt: null,
  windowStartAt: null,
  windowEndAt: null,
  yardSize: null,
  equipmentProvided: false,
  specialInstructions: '',
  priceCents: null,
}

export interface StepValidation {
  complete: boolean
  /** Shown inline, only after the customer tries to advance. */
  message?: string
}

export function validateStep(
  step: PostStep,
  draft: PostDraft,
  minPriceCents: number,
  now: Date = new Date(),
): StepValidation {
  switch (step) {
    case 'WHAT':
      return draft.categoryId
        ? { complete: true }
        : { complete: false, message: 'Pick what you need done' }

    case 'WHERE':
      return draft.propertyId
        ? { complete: true }
        : { complete: false, message: 'Choose a property' }

    case 'WHEN': {
      if (!draft.dueAt) return { complete: false, message: 'Pick when you need it done by' }
      // Injectable clock, not Date.now(): the deadline boundary is exactly the
      // case worth testing, and a function that reads the wall clock directly
      // cannot be tested at its boundary at all.
      if (draft.dueAt.getTime() <= now.getTime()) {
        return { complete: false, message: 'That time has already passed' }
      }
      if (draft.windowStartAt && draft.windowEndAt && draft.windowEndAt <= draft.windowStartAt) {
        return { complete: false, message: 'The time window must end after it starts' }
      }
      return { complete: true }
    }

    case 'HOW':
      // Everything on this step is optional — yard size falls back to the
      // property's. Blocking here would be friction for no information gained.
      return { complete: true }

    case 'PRICE': {
      if (draft.priceCents === null) return { complete: false, message: 'Set what you want to pay' }
      if (draft.priceCents < minPriceCents) {
        return {
          complete: false,
          message: `The minimum is $${(minPriceCents / 100).toFixed(0)}`,
        }
      }
      return { complete: true }
    }
  }
}

export function stepIndex(step: PostStep): number {
  return POST_STEPS.indexOf(step)
}

export function nextStep(step: PostStep): PostStep | null {
  return POST_STEPS[stepIndex(step) + 1] ?? null
}

export function previousStep(step: PostStep): PostStep | null {
  return stepIndex(step) === 0 ? null : POST_STEPS[stepIndex(step) - 1] ?? null
}

/** Steps the customer may jump straight to — everything up to the first incomplete one. */
export function reachableSteps(draft: PostDraft, minPriceCents: number, now: Date = new Date()): PostStep[] {
  const reachable: PostStep[] = []
  for (const step of POST_STEPS) {
    reachable.push(step)
    if (!validateStep(step, draft, minPriceCents, now).complete) break
  }
  return reachable
}

export function canPublish(draft: PostDraft, minPriceCents: number, now: Date = new Date()): boolean {
  return POST_STEPS.every((step) => validateStep(step, draft, minPriceCents, now).complete)
}

/** Which step a resumed draft should open on. */
export function resumeAt(draft: PostDraft, minPriceCents: number, now: Date = new Date()): PostStep {
  for (const step of POST_STEPS) {
    if (!validateStep(step, draft, minPriceCents, now).complete) return step
  }
  return 'PRICE'
}

// ---------------------------------------------------------------------------
// Deadline presets
// ---------------------------------------------------------------------------

export interface DeadlinePreset {
  key: 'TODAY' | 'TOMORROW' | 'THIS_WEEK' | 'CUSTOM'
  label: string
  /** Null for CUSTOM, which opens a picker. */
  resolve: ((now: Date) => Date) | null
}

/**
 * Presets rather than a date picker by default.
 *
 * A date picker is four taps and a decision; "Today" is one tap. Most yard work
 * is wanted soon, so the common case should be the cheap one.
 */
export const DEADLINE_PRESETS: DeadlinePreset[] = [
  {
    key: 'TODAY',
    label: 'Today',
    // 7pm, because nobody wants a mower running after dark.
    resolve: (now) => endOfDayAt(now, 19),
  },
  {
    key: 'TOMORROW',
    label: 'Tomorrow',
    resolve: (now) => endOfDayAt(new Date(now.getTime() + 86_400_000), 19),
  },
  {
    key: 'THIS_WEEK',
    label: 'This week',
    resolve: (now) => endOfDayAt(new Date(now.getTime() + 6 * 86_400_000), 19),
  },
  { key: 'CUSTOM', label: 'Pick a date', resolve: null },
]

function endOfDayAt(date: Date, hour: number): Date {
  const result = new Date(date)
  result.setHours(hour, 0, 0, 0)
  return result
}

/**
 * "Today" is only offered while there is still usable daylight to do the work.
 *
 * Offering it at 8pm produces a job nobody can claim, which burns the customer
 * and wastes a worker's tap.
 */
/**
 * Days offered when the customer wants a specific date.
 *
 * Deliberately an inline list rather than a pushed date-picker screen. Leaving
 * the wizard to answer one question means either carrying the draft through a
 * route or handing it back through params, and both are how half-filled drafts
 * get lost — which on the highest-drop-off funnel in the product is the most
 * expensive bug available.
 *
 * Two weeks out, because yard work planned further ahead than that is a
 * recurring service, and we have a better answer for those.
 */
export const CUSTOM_DATE_DAYS = 14

export function upcomingDays(now: Date, count = CUSTOM_DATE_DAYS): Date[] {
  const days: Date[] = []
  for (let offset = 0; offset < count; offset += 1) {
    const day = endOfDayAt(new Date(now.getTime() + offset * 86_400_000), 19)
    // A deadline already in the past is not a choice, it is a dead end.
    if (day.getTime() > now.getTime()) days.push(day)
  }
  return days
}

export function formatDayLabel(day: Date, now = new Date()): string {
  const days = Math.round(
    (startOfDay(day).getTime() - startOfDay(now).getTime()) / 86_400_000,
  )
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function startOfDay(date: Date): Date {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

export const LATEST_HOUR_TO_OFFER_TODAY = 16

export function availablePresets(now: Date): DeadlinePreset[] {
  return DEADLINE_PRESETS.filter(
    (preset) => preset.key !== 'TODAY' || now.getHours() < LATEST_HOUR_TO_OFFER_TODAY,
  )
}

// ---------------------------------------------------------------------------
// Price guidance
// ---------------------------------------------------------------------------

export interface PriceFeedback {
  tone: 'good' | 'fair' | 'low'
  claimLikelihood: number
  message: string
}

/**
 * Honest feedback as the customer types.
 *
 * Under-pricing is the main cause of jobs nobody claims (strategy R6), and a
 * customer whose job sits unclaimed concludes the app is broken rather than
 * that they offered too little. So we tell them the truth — with a number —
 * while they can still change it, and never block them from trying anyway.
 */
export function priceFeedback(priceCents: number, guidance: PriceGuidance): PriceFeedback {
  const mid = (guidance.suggestedLowCents + guidance.suggestedHighCents) / 2
  const ratio = priceCents / mid

  let claimLikelihood: number
  if (ratio >= 1.15) claimLikelihood = 0.95
  else if (ratio >= 1.0) claimLikelihood = 0.85
  else if (ratio >= 0.85) claimLikelihood = 0.65
  else if (ratio >= 0.7) claimLikelihood = 0.35
  else if (ratio >= 0.55) claimLikelihood = 0.15
  else claimLikelihood = 0.05

  const percent = Math.round(claimLikelihood * 100)

  if (claimLikelihood >= 0.85) {
    return { tone: 'good', claimLikelihood, message: 'Great price — this should get claimed quickly.' }
  }
  if (claimLikelihood >= 0.6) {
    return { tone: 'fair', claimLikelihood, message: `Fair price. About ${percent}% of jobs like this get claimed.` }
  }
  return {
    tone: 'low',
    claimLikelihood,
    message: `Below the local rate — only about ${percent}% of jobs at this price get claimed.`,
  }
}

/** The price the input starts at: the middle of the suggested range, rounded to $5. */
export function suggestedStartingPrice(guidance: PriceGuidance): number {
  const mid = (guidance.suggestedLowCents + guidance.suggestedHighCents) / 2
  return Math.round(mid / 500) * 500
}

// ---------------------------------------------------------------------------
// Cost breakdown
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  jobPriceCents: number
  serviceFeeCents: number
  totalCents: number
}

/**
 * What the customer will actually be charged.
 *
 * Shown in full before they publish. A fee discovered on a receipt rather than
 * before the decision is how a marketplace earns a chargeback and a one-star
 * review at the same time.
 */
export function costBreakdown(
  priceCents: number,
  feeBps: number,
  feeMinCents: number,
): CostBreakdown {
  const serviceFeeCents = Math.max(Math.round((priceCents * feeBps) / 10_000), feeMinCents)
  return { jobPriceCents: priceCents, serviceFeeCents, totalCents: priceCents + serviceFeeCents }
}

// ---------------------------------------------------------------------------
// Category helpers
// ---------------------------------------------------------------------------

export function estimatedMinutesFor(category: Category, yardSize: YardSize | null): number {
  if (!yardSize) return category.baseMinutes
  const acres: Record<YardSize, number> = {
    UNDER_QUARTER_ACRE: 0.15, QUARTER_TO_HALF: 0.375,
    HALF_TO_ONE: 0.75, ONE_TO_TWO: 1.5, OVER_TWO: 3,
  }
  // Sublinear: setup and teardown do not scale with lot size.
  const factor = Math.pow(acres[yardSize] / 0.375, 0.75)
  return Math.max(15, Math.round(category.baseMinutes * factor))
}

export const YARD_SIZE_LABELS: Record<YardSize, string> = {
  UNDER_QUARTER_ACRE: 'Under ¼ acre',
  QUARTER_TO_HALF: '¼ – ½ acre',
  HALF_TO_ONE: '½ – 1 acre',
  ONE_TO_TWO: '1 – 2 acres',
  OVER_TWO: 'Over 2 acres',
}
