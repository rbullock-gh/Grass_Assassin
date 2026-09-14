/**
 * The registry of everything an admin may change without a deploy.
 *
 * The brief was explicit that percentages and fees must be configurable from
 * the dashboard rather than hard-coded, and the read side already honours that.
 * This is the other half: what the keys mean, what units they are in, and what
 * values are actually safe to save.
 *
 * Bounds are not bureaucracy. A commission typed as 1200 when 1200 basis points
 * was meant is a 12% fee; typed into a percent field it is a 1,200% fee, and
 * the first job posted afterwards charges a customer twelve times the price.
 * Every editable value therefore carries a range, and the range lives here so
 * the form and the writer cannot disagree about it.
 */

export type ConfigUnit = 'BPS' | 'CENTS' | 'HOURS' | 'MINUTES'

export interface ConfigField {
  key: string
  label: string
  /** What breaks if this is wrong. Shown under the input. */
  help: string
  unit: ConfigUnit
  min: number
  max: number
}

export const CONFIG_FIELDS: readonly ConfigField[] = [
  {
    key: 'fees.worker_commission_bps',
    label: 'Worker commission',
    help: 'Taken from the job price before the worker is paid. Above roughly 25% workers leave for a competitor.',
    unit: 'BPS', min: 0, max: 3000,
  },
  {
    key: 'fees.customer_service_fee_bps',
    label: 'Customer service fee',
    help: 'Added on top of the job price. Visible to the customer before they commit, never after.',
    unit: 'BPS', min: 0, max: 2500,
  },
  {
    key: 'fees.customer_service_fee_min_cents',
    label: 'Service fee floor',
    help: 'So a small job still covers card processing. Set too high it makes cheap jobs absurd.',
    unit: 'CENTS', min: 0, max: 2000,
  },
  {
    key: 'fees.min_job_price_cents',
    label: 'Minimum job price',
    help: 'Below this the unit economics invert — the platform loses money on every job.',
    unit: 'CENTS', min: 500, max: 20_000,
  },
  {
    key: 'fees.max_job_price_cents',
    label: 'Maximum job price',
    help: 'Guards fat-finger entry and card testing. A $50,000 lawn is a fraud attempt.',
    unit: 'CENTS', min: 10_000, max: 5_000_000,
  },
  {
    key: 'cancellation.grace_minutes',
    label: 'Free cancellation window',
    help: 'How long after a claim a customer may cancel at no cost. Too long and workers plan around jobs that evaporate.',
    unit: 'MINUTES', min: 0, max: 1440,
  },
  {
    key: 'cancellation.late_hours',
    label: 'Late cancellation window',
    help: 'Hours before the job window where the higher penalty applies.',
    unit: 'HOURS', min: 0, max: 168,
  },
  {
    key: 'cancellation.early_penalty_bps',
    label: 'Early cancellation penalty',
    help: 'Paid to the worker, not kept by the platform.',
    unit: 'BPS', min: 0, max: 10_000,
  },
  {
    key: 'cancellation.late_penalty_bps',
    label: 'Late cancellation penalty',
    help: 'Paid to the worker. Must be at least the early penalty or cancelling late is cheaper than cancelling early.',
    unit: 'BPS', min: 0, max: 10_000,
  },
  {
    key: 'approval.auto_approve_hours',
    label: 'Auto-approval window',
    help: 'How long a customer has to review before work approves itself. Too short and disputes rise; too long and workers wait for money they earned.',
    unit: 'HOURS', min: 1, max: 336,
  },
] as const

export function configField(key: string): ConfigField | undefined {
  return CONFIG_FIELDS.find((field) => field.key === key)
}

export interface ConfigValidation {
  ok: boolean
  /** The value to persist. Only present when ok. */
  value?: number
  error?: string
}

/**
 * Validates one value against its own field.
 *
 * Takes the raw string a form produces, because that is where the dangerous
 * inputs come from: an empty box, a stray letter, a number with a comma in it.
 */
export function validateConfigValue(key: string, raw: unknown): ConfigValidation {
  const field = configField(key)
  if (!field) return { ok: false, error: 'Unknown setting' }

  const text = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : raw
  if (text === '' || text === null || text === undefined) {
    return { ok: false, error: 'Enter a value' }
  }

  const value = Number(text)
  if (!Number.isFinite(value)) return { ok: false, error: 'Must be a number' }
  if (!Number.isInteger(value)) {
    // Every unit here is a whole basis point, cent, minute or hour. A fraction
    // means the person is typing percent or dollars into the wrong box.
    return { ok: false, error: `Must be a whole number of ${unitNoun(field.unit)}` }
  }
  if (value < field.min || value > field.max) {
    return { ok: false, error: `Must be between ${formatConfigValue(field, field.min)} and ${formatConfigValue(field, field.max)}` }
  }

  return { ok: true, value }
}

function unitNoun(unit: ConfigUnit): string {
  switch (unit) {
    case 'BPS': return 'basis points'
    case 'CENTS': return 'cents'
    case 'HOURS': return 'hours'
    case 'MINUTES': return 'minutes'
  }
}

/** How a stored value reads to a person. */
export function formatConfigValue(field: ConfigField, value: number): string {
  switch (field.unit) {
    case 'BPS': return `${(value / 100).toFixed(2).replace(/\.00$/, '')}%`
    case 'CENTS': return `$${(value / 100).toFixed(2)}`
    case 'HOURS': return `${value}h`
    case 'MINUTES': return `${value} min`
  }
}

/**
 * Rules that involve more than one field.
 *
 * Checked on the whole set rather than per input, because each of these is
 * perfectly legal on its own and only wrong in combination — the kind of thing
 * a per-field validator cannot see and a customer discovers at checkout.
 */
export function validateConfigSet(values: Record<string, number>): string[] {
  const problems: string[] = []

  const min = values['fees.min_job_price_cents']
  const max = values['fees.max_job_price_cents']
  if (min !== undefined && max !== undefined && min >= max) {
    problems.push('The minimum job price must be below the maximum, or no price is postable.')
  }

  const early = values['cancellation.early_penalty_bps']
  const late = values['cancellation.late_penalty_bps']
  if (early !== undefined && late !== undefined && late < early) {
    problems.push('The late cancellation penalty must be at least the early one, or cancelling at the last minute is cheaper than cancelling with notice.')
  }

  const commission = values['fees.worker_commission_bps']
  const serviceFee = values['fees.customer_service_fee_bps']
  if (commission !== undefined && serviceFee !== undefined && commission + serviceFee > 5000) {
    problems.push('Commission plus service fee is over 50% of the job price. That is a number a marketplace does not come back from.')
  }

  const feeFloor = values['fees.customer_service_fee_min_cents']
  if (min !== undefined && feeFloor !== undefined && feeFloor > min / 2) {
    problems.push('The service fee floor is more than half the minimum job price, so the cheapest job would be mostly fee.')
  }

  return problems
}
