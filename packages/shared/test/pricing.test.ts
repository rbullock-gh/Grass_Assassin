import { describe, it, expect } from 'vitest'
import {
  quoteJob,
  applyBps,
  DEFAULT_FEE_CONFIG,
  resolveCancellation,
  DEFAULT_CANCELLATION_POLICY,
  effectiveCommissionBps,
  priceGuidance,
  formatCents,
  type JobQuote,
} from '../src/domain/pricing.js'

describe('applyBps', () => {
  it('applies basis points with half-up rounding', () => {
    expect(applyBps(6000, 1200)).toBe(720) // 12% of $60.00
    expect(applyBps(6000, 800)).toBe(480)
    expect(applyBps(100, 1)).toBe(0) // 0.01% of $1 rounds to zero
    expect(applyBps(2500, 800)).toBe(200)
  })

  it('rejects non-integer cents, which is how rounding drift starts', () => {
    expect(() => applyBps(60.5, 1200)).toThrow(TypeError)
  })
})

describe('quoteJob', () => {
  it('produces the documented economics for a $60 job', () => {
    const q = quoteJob(6000)
    expect(q.jobPriceCents).toBe(6000)
    expect(q.serviceFeeCents).toBe(480)
    expect(q.customerTotalCents).toBe(6480)
    expect(q.workerCommissionCents).toBe(720)
    expect(q.workerPayoutCents).toBe(5280)
    expect(q.platformGrossCents).toBe(1200)
  })

  it('never loses or invents a cent', () => {
    // Every price from the $25 floor to $500, one cent at a time would be slow;
    // step through a wide range including awkward values.
    for (let price = 2500; price <= 50_000; price += 7) {
      const q = quoteJob(price)
      expect(q.workerPayoutCents + q.workerCommissionCents).toBe(q.jobPriceCents)
      expect(q.customerTotalCents - q.serviceFeeCents).toBe(q.jobPriceCents)
      // Platform gross is exactly what neither side keeps.
      expect(q.customerTotalCents - q.workerPayoutCents).toBe(q.platformGrossCents)
      expect(Number.isInteger(q.customerTotalCents)).toBe(true)
      expect(Number.isInteger(q.workerPayoutCents)).toBe(true)
    }
  })

  it('applies the service fee floor on small jobs', () => {
    // 8% of $25 is $2.00, below the $2.99 minimum.
    const q = quoteJob(2500)
    expect(q.serviceFeeCents).toBe(DEFAULT_FEE_CONFIG.customerServiceFeeMinCents)
    expect(q.customerTotalCents).toBe(2500 + 299)
  })

  it('stops using the floor once the percentage exceeds it', () => {
    // 8% of $37.50 = $3.00, just over the floor.
    expect(quoteJob(3750).serviceFeeCents).toBe(300)
  })

  it('enforces the minimum job price, which exists for unit-economics reasons', () => {
    expect(() => quoteJob(2499)).toThrow(RangeError)
    expect(() => quoteJob(2500)).not.toThrow()
  })

  it('enforces a maximum to contain fat-finger and fraud', () => {
    expect(() => quoteJob(500_001)).toThrow(RangeError)
  })

  it('honours per-market fee overrides', () => {
    const q = quoteJob(10_000, { ...DEFAULT_FEE_CONFIG, workerCommissionBps: 1000, customerServiceFeeBps: 500 })
    expect(q.workerCommissionCents).toBe(1000)
    expect(q.serviceFeeCents).toBe(500)
    expect(q.workerPayoutCents).toBe(9000)
  })
})

describe('effectiveCommissionBps', () => {
  it('applies earned rank discounts', () => {
    expect(effectiveCommissionBps(1200, 200)).toBe(1000)
  })
  it('never goes negative even with a misconfigured rank table', () => {
    expect(effectiveCommissionBps(1200, 5000)).toBe(0)
  })
})

describe('resolveCancellation', () => {
  const quote: JobQuote = quoteJob(6000)
  const scheduledFor = new Date('2026-06-01T18:00:00Z')

  it('fully refunds a cancellation before any claim', () => {
    const r = resolveCancellation({
      quote, actor: 'CUSTOMER', status: 'POSTED', claimedAt: null,
      scheduledFor, now: new Date('2026-05-30T10:00:00Z'),
    })
    expect(r.customerRefundCents).toBe(quote.customerTotalCents)
    expect(r.workerCompensationCents).toBe(0)
  })

  it('fully refunds inside the post-claim grace period', () => {
    const claimedAt = new Date('2026-05-30T10:00:00Z')
    const r = resolveCancellation({
      quote, actor: 'CUSTOMER', status: 'CLAIMED', claimedAt,
      scheduledFor, now: new Date('2026-05-30T10:45:00Z'), // 45 min later
    })
    expect(r.customerRefundCents).toBe(quote.customerTotalCents)
    expect(r.workerCompensationCents).toBe(0)
  })

  it('charges the early penalty after grace but well before the window', () => {
    const claimedAt = new Date('2026-05-29T10:00:00Z')
    const r = resolveCancellation({
      quote, actor: 'CUSTOMER', status: 'CLAIMED', claimedAt,
      scheduledFor, now: new Date('2026-05-30T10:00:00Z'), // 32h before window
    })
    const expectedPenalty = applyBps(6000, DEFAULT_CANCELLATION_POLICY.earlyCancelPenaltyBps)
    expect(r.workerCompensationCents).toBe(expectedPenalty)
    expect(r.customerRefundCents).toBe(quote.customerTotalCents - expectedPenalty)
  })

  it('charges the late penalty inside the 12h window', () => {
    const claimedAt = new Date('2026-05-29T10:00:00Z')
    const r = resolveCancellation({
      quote, actor: 'CUSTOMER', status: 'CLAIMED', claimedAt,
      scheduledFor, now: new Date('2026-06-01T12:00:00Z'), // 6h before window
    })
    const expectedPenalty = applyBps(6000, DEFAULT_CANCELLATION_POLICY.lateCancelPenaltyBps)
    expect(r.workerCompensationCents).toBe(expectedPenalty)
  })

  it('pays the worker in full once they are en route', () => {
    const r = resolveCancellation({
      quote, actor: 'CUSTOMER', status: 'EN_ROUTE', claimedAt: new Date('2026-06-01T16:00:00Z'),
      scheduledFor, now: new Date('2026-06-01T17:50:00Z'),
    })
    expect(r.workerCompensationCents).toBe(quote.workerPayoutCents)
    expect(r.customerRefundCents).toBe(quote.serviceFeeCents)
    expect(r.platformRetainedCents).toBe(quote.workerCommissionCents)
  })

  it('never charges the customer when the worker is the one backing out', () => {
    const r = resolveCancellation({
      quote, actor: 'WORKER', status: 'EN_ROUTE', claimedAt: new Date('2026-06-01T16:00:00Z'),
      scheduledFor, now: new Date('2026-06-01T17:50:00Z'),
    })
    expect(r.customerRefundCents).toBe(quote.customerTotalCents)
    expect(r.workerCompensationCents).toBe(0)
  })

  it('conserves money in every cancellation path', () => {
    const paths = [
      { status: 'POSTED' as const, claimedAt: null, actor: 'CUSTOMER' as const },
      { status: 'CLAIMED' as const, claimedAt: new Date('2026-05-29T10:00:00Z'), actor: 'CUSTOMER' as const },
      { status: 'EN_ROUTE' as const, claimedAt: new Date('2026-05-29T10:00:00Z'), actor: 'CUSTOMER' as const },
      { status: 'IN_PROGRESS' as const, claimedAt: new Date('2026-05-29T10:00:00Z'), actor: 'CUSTOMER' as const },
      { status: 'CLAIMED' as const, claimedAt: new Date('2026-05-29T10:00:00Z'), actor: 'WORKER' as const },
    ]
    for (const p of paths) {
      const r = resolveCancellation({
        quote, actor: p.actor, status: p.status, claimedAt: p.claimedAt,
        scheduledFor, now: new Date('2026-05-30T10:00:00Z'),
      })
      const disbursed = r.customerRefundCents + r.workerCompensationCents + r.platformRetainedCents
      expect(disbursed, `path ${p.status}/${p.actor} must disburse exactly what was collected`)
        .toBe(quote.customerTotalCents)
    }
  })
})

describe('priceGuidance', () => {
  it('rates a price at the top of the market as very likely to claim', () => {
    expect(priceGuidance(8000, 5500, 7000).claimLikelihood).toBeGreaterThanOrEqual(0.9)
  })
  it('warns honestly about severe underpricing', () => {
    const g = priceGuidance(2500, 5500, 7000)
    expect(g.claimLikelihood).toBeLessThanOrEqual(0.15)
    expect(g.message).toMatch(/below the local rate/i)
  })
  it('is monotonic — more money never lowers the estimate', () => {
    let previous = 0
    for (let price = 2000; price <= 12_000; price += 250) {
      const l = priceGuidance(price, 5500, 7000).claimLikelihood
      expect(l).toBeGreaterThanOrEqual(previous)
      previous = l
    }
  })
})

describe('formatCents', () => {
  it('formats dollars and cents correctly', () => {
    expect(formatCents(6000)).toBe('$60.00')
    expect(formatCents(6480)).toBe('$64.80')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(-720)).toBe('-$7.20')
  })
})
