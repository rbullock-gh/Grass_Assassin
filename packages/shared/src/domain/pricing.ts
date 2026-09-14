/**
 * Marketplace money math.
 *
 * Every amount in this system is an integer number of cents. Floating point
 * currency arithmetic produces off-by-one-cent errors that do not reconcile,
 * and a marketplace that cannot reconcile its ledger cannot operate.
 *
 * Fee percentages live in the database (`platform_config`) and are editable per
 * market from the admin dashboard. The values below are defaults only — nothing
 * here is the source of truth at runtime.
 *
 * See docs/00-strategy.md §5 for the economics behind these defaults.
 */

export interface FeeConfig {
  /** Worker commission, basis points. 1200 = 12%. */
  workerCommissionBps: number
  /** Customer service fee, basis points. 800 = 8%. */
  customerServiceFeeBps: number
  /** Customer service fee floor, cents. */
  customerServiceFeeMinCents: number
  /** Minimum publishable job price, cents. */
  minJobPriceCents: number
  /** Maximum publishable job price, cents. Guards fat-finger and fraud. */
  maxJobPriceCents: number
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  workerCommissionBps: 1200,
  customerServiceFeeBps: 800,
  customerServiceFeeMinCents: 299,
  minJobPriceCents: 2500,
  maxJobPriceCents: 500_000,
}

export interface JobQuote {
  /** The price the customer set for the work itself. */
  jobPriceCents: number
  /** Platform fee charged to the customer, on top of the job price. */
  serviceFeeCents: number
  /** Total charged to the customer's payment method. */
  customerTotalCents: number
  /** Commission deducted from the job price. */
  workerCommissionCents: number
  /** What lands in the worker's balance, before tips. */
  workerPayoutCents: number
  /** Gross platform revenue (service fee + commission), before processor costs. */
  platformGrossCents: number
}

/** Basis-point application with half-up rounding. Callers must pass integer cents. */
export function applyBps(amountCents: number, bps: number): number {
  if (!Number.isInteger(amountCents)) {
    throw new TypeError(`amountCents must be an integer, received ${amountCents}`)
  }
  return Math.round((amountCents * bps) / 10_000)
}

export function quoteJob(jobPriceCents: number, config: FeeConfig = DEFAULT_FEE_CONFIG): JobQuote {
  if (!Number.isInteger(jobPriceCents)) {
    throw new TypeError(`jobPriceCents must be an integer, received ${jobPriceCents}`)
  }
  if (jobPriceCents < config.minJobPriceCents) {
    throw new RangeError(
      `Job price ${jobPriceCents} is below the ${config.minJobPriceCents} minimum`,
    )
  }
  if (jobPriceCents > config.maxJobPriceCents) {
    throw new RangeError(
      `Job price ${jobPriceCents} exceeds the ${config.maxJobPriceCents} maximum`,
    )
  }

  const serviceFeeCents = Math.max(
    applyBps(jobPriceCents, config.customerServiceFeeBps),
    config.customerServiceFeeMinCents,
  )
  const workerCommissionCents = applyBps(jobPriceCents, config.workerCommissionBps)

  return {
    jobPriceCents,
    serviceFeeCents,
    customerTotalCents: jobPriceCents + serviceFeeCents,
    workerCommissionCents,
    workerPayoutCents: jobPriceCents - workerCommissionCents,
    platformGrossCents: serviceFeeCents + workerCommissionCents,
  }
}

/**
 * Rank-based commission discounts. Earned, never purchased — see strategy §5,
 * "the line we do not cross".
 */
export function effectiveCommissionBps(baseBps: number, rankDiscountBps: number): number {
  return Math.max(0, baseBps - rankDiscountBps)
}

// ---------------------------------------------------------------------------
// Cancellation policy
// ---------------------------------------------------------------------------

export type CancelActor = 'CUSTOMER' | 'WORKER'

export interface CancellationPolicy {
  /** Grace period after a claim during which a customer cancels free. */
  graceMinutesAfterClaim: number
  /** Inside this many hours of the scheduled window, the late penalty applies. */
  lateCancelHours: number
  /** Customer penalty outside the late window, bps of job price. */
  earlyCancelPenaltyBps: number
  /** Customer penalty inside the late window, bps of job price. */
  lateCancelPenaltyBps: number
}

export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  graceMinutesAfterClaim: 60,
  lateCancelHours: 12,
  earlyCancelPenaltyBps: 1500,
  lateCancelPenaltyBps: 5000,
}

export interface CancellationOutcome {
  /** Refunded to the customer, cents. */
  customerRefundCents: number
  /** Paid to the worker as compensation, cents. */
  workerCompensationCents: number
  /** Platform revenue retained, cents. */
  platformRetainedCents: number
  reason: string
}

export interface CancellationInput {
  quote: JobQuote
  actor: CancelActor
  /** Job status at the moment of cancellation. */
  status: 'POSTED' | 'CLAIMED' | 'EN_ROUTE' | 'IN_PROGRESS'
  /** Null when the job was never claimed. */
  claimedAt: Date | null
  /** Start of the customer's requested window; falls back to the deadline. */
  scheduledFor: Date
  now: Date
  policy?: CancellationPolicy
}

/**
 * Determines who gets what when a job is cancelled.
 *
 * Design intent: a worker who has already invested travel time is never left with
 * nothing, and a customer who cancels promptly is never punished. The asymmetry is
 * deliberate — worker supply is the scarcer side of this marketplace.
 */
export function resolveCancellation(input: CancellationInput): CancellationOutcome {
  const policy = input.policy ?? DEFAULT_CANCELLATION_POLICY
  const { quote, actor, status, claimedAt, scheduledFor, now } = input

  // Nothing has been captured yet before a claim: full release, no money moves.
  if (status === 'POSTED' || claimedAt === null) {
    return {
      customerRefundCents: quote.customerTotalCents,
      workerCompensationCents: 0,
      platformRetainedCents: 0,
      reason: 'Cancelled before claim — full refund',
    }
  }

  // A worker backing out never costs the customer money. It costs the worker points.
  if (actor === 'WORKER') {
    return {
      customerRefundCents: quote.customerTotalCents,
      workerCompensationCents: 0,
      platformRetainedCents: 0,
      reason: 'Worker cancelled — full refund to customer',
    }
  }

  // Worker is already on site or travelling: they are made whole.
  if (status === 'EN_ROUTE' || status === 'IN_PROGRESS') {
    return {
      customerRefundCents: quote.serviceFeeCents,
      workerCompensationCents: quote.workerPayoutCents,
      platformRetainedCents: quote.workerCommissionCents,
      reason: 'Cancelled after worker en route — worker paid in full',
    }
  }

  const minutesSinceClaim = (now.getTime() - claimedAt.getTime()) / 60_000
  if (minutesSinceClaim <= policy.graceMinutesAfterClaim) {
    return {
      customerRefundCents: quote.customerTotalCents,
      workerCompensationCents: 0,
      platformRetainedCents: 0,
      reason: `Cancelled within ${policy.graceMinutesAfterClaim}-minute grace period — full refund`,
    }
  }

  const hoursUntilScheduled = (scheduledFor.getTime() - now.getTime()) / 3_600_000
  const isLate = hoursUntilScheduled < policy.lateCancelHours
  const penaltyBps = isLate ? policy.lateCancelPenaltyBps : policy.earlyCancelPenaltyBps
  const penaltyCents = applyBps(quote.jobPriceCents, penaltyBps)

  // The penalty is compensation for the worker's reserved time; the platform takes
  // nothing extra from a cancellation beyond the service fee it already earned.
  return {
    customerRefundCents: quote.customerTotalCents - penaltyCents,
    workerCompensationCents: penaltyCents,
    platformRetainedCents: 0,
    reason: isLate
      ? `Cancelled within ${policy.lateCancelHours}h of scheduled window — ${penaltyBps / 100}% to worker`
      : `Cancelled after grace period — ${penaltyBps / 100}% to worker`,
  }
}

// ---------------------------------------------------------------------------
// Price guidance (strategy R6)
// ---------------------------------------------------------------------------

export interface PriceGuidance {
  suggestedLowCents: number
  suggestedHighCents: number
  /** 0..1 estimate that a job at this price gets claimed before its deadline. */
  claimLikelihood: number
  message: string
}

/**
 * Estimates claim likelihood so the customer gets honest feedback while typing.
 *
 * The curve is a placeholder until we have real claim-rate-versus-price data per
 * market; it is deliberately shaped so that under-pricing is discouraged without
 * being blocked. Replace with the empirical model once ~5k jobs exist
 * (see strategy §3.5).
 */
export function priceGuidance(
  priceCents: number,
  marketLowCents: number,
  marketHighCents: number,
): PriceGuidance {
  const mid = (marketLowCents + marketHighCents) / 2
  const ratio = priceCents / mid

  let claimLikelihood: number
  if (ratio >= 1.15) claimLikelihood = 0.95
  else if (ratio >= 1.0) claimLikelihood = 0.85
  else if (ratio >= 0.85) claimLikelihood = 0.65
  else if (ratio >= 0.7) claimLikelihood = 0.35
  else if (ratio >= 0.55) claimLikelihood = 0.15
  else claimLikelihood = 0.05

  const pct = Math.round(claimLikelihood * 100)
  const message =
    claimLikelihood >= 0.85
      ? 'Great price — this should get claimed quickly.'
      : claimLikelihood >= 0.6
        ? `Fair price. About ${pct}% of jobs like this get claimed.`
        : `This is below the local rate. Only about ${pct}% of jobs at this price get claimed.`

  return {
    suggestedLowCents: marketLowCents,
    suggestedHighCents: marketHighCents,
    claimLikelihood,
    message,
  }
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
