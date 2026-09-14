import { describe, expect, it } from 'vitest'
import {
  CONFIG_FIELDS, configField, validateConfigValue, validateConfigSet, formatConfigValue,
} from '../src/domain/platform-config.js'
import { DEFAULT_FEE_CONFIG } from '../src/domain/pricing.js'

describe('the editable settings registry', () => {
  it('gives every field a range', () => {
    for (const field of CONFIG_FIELDS) {
      expect(field.min, field.key).toBeLessThan(field.max)
    }
  })

  it('explains what breaks, not just what the field is called', () => {
    // A number an admin can change without a deploy needs to say what it costs
    // to get wrong, or someone will find out by charging a real customer.
    for (const field of CONFIG_FIELDS) {
      expect(field.help.length, field.key).toBeGreaterThan(40)
    }
  })

  it('accepts the values the platform actually ships with', () => {
    // A bound that excludes the current production value is a bound that turns
    // the settings page into a trap the first time anyone saves it.
    const shipped: Record<string, number> = {
      'fees.worker_commission_bps': DEFAULT_FEE_CONFIG.workerCommissionBps,
      'fees.customer_service_fee_bps': DEFAULT_FEE_CONFIG.customerServiceFeeBps,
      'fees.customer_service_fee_min_cents': DEFAULT_FEE_CONFIG.customerServiceFeeMinCents,
      'fees.min_job_price_cents': DEFAULT_FEE_CONFIG.minJobPriceCents,
      'fees.max_job_price_cents': DEFAULT_FEE_CONFIG.maxJobPriceCents,
      'approval.auto_approve_hours': 24,
    }
    for (const [key, value] of Object.entries(shipped)) {
      const result = validateConfigValue(key, String(value))
      expect(result.ok, `${key}=${value}: ${result.error}`).toBe(true)
    }
    expect(validateConfigSet(shipped)).toEqual([])
  })
})

describe('validating one value', () => {
  it('rejects an unknown key rather than writing it', () => {
    expect(validateConfigValue('fees.made_up', '10').ok).toBe(false)
  })

  it('rejects the empty box', () => {
    expect(validateConfigValue('approval.auto_approve_hours', '').error).toBe('Enter a value')
    expect(validateConfigValue('approval.auto_approve_hours', '   ').error).toBe('Enter a value')
  })

  it('rejects anything that is not a number', () => {
    expect(validateConfigValue('approval.auto_approve_hours', 'twelve').error).toBe('Must be a number')
  })

  it('tolerates a thousands separator, because people type them', () => {
    const result = validateConfigValue('fees.max_job_price_cents', '200,000')
    expect(result.ok).toBe(true)
    expect(result.value).toBe(200_000)
  })

  it('rejects a fraction, which means the wrong unit was typed', () => {
    // "12.5" in a basis-points box is someone thinking in percent.
    expect(validateConfigValue('fees.worker_commission_bps', '12.5').error)
      .toContain('whole number of basis points')
  })

  it('catches the mistake that would charge twelve times the price', () => {
    // 1200 meant as basis points is 12%. Typed where percent was meant it is
    // 1,200%, and the next customer is charged twelve times over.
    expect(validateConfigValue('fees.worker_commission_bps', '1200').ok).toBe(true)
    expect(validateConfigValue('fees.worker_commission_bps', '120000').ok).toBe(false)
  })

  it('states the range in human units, not raw ones', () => {
    // "between 0% and 30%" is actionable; "between 0 and 3000" invites the
    // exact unit confusion the check exists to stop.
    expect(validateConfigValue('fees.worker_commission_bps', '9999').error).toContain('%')
    expect(validateConfigValue('fees.min_job_price_cents', '1').error).toContain('$')
  })

  it('accepts both ends of every range', () => {
    for (const field of CONFIG_FIELDS) {
      expect(validateConfigValue(field.key, String(field.min)).ok, `${field.key} min`).toBe(true)
      expect(validateConfigValue(field.key, String(field.max)).ok, `${field.key} max`).toBe(true)
      expect(validateConfigValue(field.key, String(field.min - 1)).ok, `${field.key} under`).toBe(false)
      expect(validateConfigValue(field.key, String(field.max + 1)).ok, `${field.key} over`).toBe(false)
    }
  })
})

describe('rules that span fields', () => {
  it('refuses a minimum price above the maximum', () => {
    const problems = validateConfigSet({
      'fees.min_job_price_cents': 50_000, 'fees.max_job_price_cents': 20_000,
    })
    expect(problems[0]).toContain('no price is postable')
  })

  it('refuses a late penalty cheaper than the early one', () => {
    // Otherwise cancelling at the last minute costs less than cancelling with
    // notice, and the policy teaches exactly the wrong behaviour.
    const problems = validateConfigSet({
      'cancellation.early_penalty_bps': 2000, 'cancellation.late_penalty_bps': 1000,
    })
    expect(problems[0]).toContain('cheaper than cancelling with notice')
  })

  it('allows equal penalties', () => {
    expect(validateConfigSet({
      'cancellation.early_penalty_bps': 2000, 'cancellation.late_penalty_bps': 2000,
    })).toEqual([])
  })

  it('refuses a combined take over half the job price', () => {
    const problems = validateConfigSet({
      'fees.worker_commission_bps': 3000, 'fees.customer_service_fee_bps': 2500,
    })
    expect(problems[0]).toContain('50%')
  })

  it('refuses a fee floor that would eat the cheapest job', () => {
    const problems = validateConfigSet({
      'fees.min_job_price_cents': 2500, 'fees.customer_service_fee_min_cents': 2000,
    })
    expect(problems[0]).toContain('mostly fee')
  })

  it('reports every problem at once', () => {
    const problems = validateConfigSet({
      'fees.min_job_price_cents': 50_000, 'fees.max_job_price_cents': 20_000,
      'cancellation.early_penalty_bps': 2000, 'cancellation.late_penalty_bps': 1000,
    })
    expect(problems.length).toBe(2)
  })

  it('says nothing when only one side of a pair is being changed', () => {
    expect(validateConfigSet({ 'fees.min_job_price_cents': 2500 })).toEqual([])
  })
})

describe('displaying a value', () => {
  it('reads basis points as a percentage', () => {
    expect(formatConfigValue(configField('fees.worker_commission_bps')!, 1200)).toBe('12%')
    expect(formatConfigValue(configField('fees.worker_commission_bps')!, 1250)).toBe('12.50%')
  })

  it('reads cents as money', () => {
    expect(formatConfigValue(configField('fees.min_job_price_cents')!, 2500)).toBe('$25.00')
  })

  it('keeps hours and minutes as they are', () => {
    expect(formatConfigValue(configField('approval.auto_approve_hours')!, 24)).toBe('24h')
    expect(formatConfigValue(configField('cancellation.grace_minutes')!, 30)).toBe('30 min')
  })
})
