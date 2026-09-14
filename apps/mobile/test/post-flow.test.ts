import { describe, it, expect } from 'vitest'
import {
  POST_STEPS, EMPTY_DRAFT, validateStep, nextStep, previousStep, reachableSteps,
  canPublish, resumeAt, availablePresets, DEADLINE_PRESETS, priceFeedback,
  suggestedStartingPrice, costBreakdown, estimatedMinutesFor, LATEST_HOUR_TO_OFFER_TODAY,
  type PostDraft,
} from '@/lib/post-flow'
import type { Category, PriceGuidance } from '@grassassassin/client'

const MIN_PRICE = 2500

const guidance: PriceGuidance = {
  suggestedLowCents: 5500, suggestedHighCents: 7500, estimatedMinutes: 45,
}

const category: Category = {
  id: 'c1', slug: 'mow', name: 'Lawn Mowing', icon: 'mower',
  difficulty: 1, baseMinutes: 45, typicalLowCents: 5500, typicalHighCents: 7500,
}

function draft(overrides: Partial<PostDraft> = {}): PostDraft {
  return { ...EMPTY_DRAFT, ...overrides }
}

const complete = (): PostDraft => draft({
  categoryId: 'c1',
  propertyId: 'p1',
  dueAt: new Date(Date.now() + 86_400_000),
  priceCents: 6000,
})

describe('step validation', () => {
  it('blocks WHAT until a category is chosen', () => {
    expect(validateStep('WHAT', draft(), MIN_PRICE).complete).toBe(false)
    expect(validateStep('WHAT', draft({ categoryId: 'c1' }), MIN_PRICE).complete).toBe(true)
  })

  it('blocks WHERE until a property is chosen', () => {
    expect(validateStep('WHERE', draft(), MIN_PRICE).complete).toBe(false)
    expect(validateStep('WHERE', draft({ propertyId: 'p1' }), MIN_PRICE).complete).toBe(true)
  })

  it('rejects a deadline in the past', () => {
    const past = draft({ dueAt: new Date(Date.now() - 3_600_000) })
    const result = validateStep('WHEN', past, MIN_PRICE)
    expect(result.complete).toBe(false)
    expect(result.message).toMatch(/already passed/i)
  })

  it('rejects a time window that ends before it starts', () => {
    const backwards = draft({
      dueAt: new Date(Date.now() + 86_400_000),
      windowStartAt: new Date(Date.now() + 7200_000),
      windowEndAt: new Date(Date.now() + 3600_000),
    })
    expect(validateStep('WHEN', backwards, MIN_PRICE).complete).toBe(false)
  })

  it('treats HOW as always complete, since everything on it is optional', () => {
    // Blocking here would be friction for no information gained.
    expect(validateStep('HOW', draft(), MIN_PRICE).complete).toBe(true)
  })

  it('enforces the minimum price with the actual figure', () => {
    const cheap = draft({ priceCents: 1000 })
    const result = validateStep('PRICE', cheap, MIN_PRICE)
    expect(result.complete).toBe(false)
    expect(result.message).toContain('$25')
  })

  it('accepts a price exactly at the minimum', () => {
    expect(validateStep('PRICE', draft({ priceCents: MIN_PRICE }), MIN_PRICE).complete).toBe(true)
  })

  it('distinguishes "no price set" from "price too low"', () => {
    expect(validateStep('PRICE', draft(), MIN_PRICE).message).toMatch(/set what you want/i)
    expect(validateStep('PRICE', draft({ priceCents: 100 }), MIN_PRICE).message).toMatch(/minimum/i)
  })
})

describe('step navigation', () => {
  it('walks forward and back through the five steps', () => {
    expect(nextStep('WHAT')).toBe('WHERE')
    expect(nextStep('PRICE')).toBeNull()
    expect(previousStep('WHAT')).toBeNull()
    expect(previousStep('PRICE')).toBe('HOW')
  })

  it('asks for money LAST', () => {
    // Asking before the customer has invested any effort is how a funnel dies.
    expect(POST_STEPS[POST_STEPS.length - 1]).toBe('PRICE')
    expect(POST_STEPS[0]).toBe('WHAT')
  })

  it('lets a customer jump back to any completed step', () => {
    const partial = draft({ categoryId: 'c1', propertyId: 'p1' })
    const reachable = reachableSteps(partial, MIN_PRICE)
    expect(reachable).toContain('WHAT')
    expect(reachable).toContain('WHERE')
    expect(reachable).toContain('WHEN')
    // But not past the first incomplete step.
    expect(reachable).not.toContain('PRICE')
  })

  it('reaches every step once the draft is complete', () => {
    expect(reachableSteps(complete(), MIN_PRICE)).toEqual([...POST_STEPS])
  })
})

describe('publish gate', () => {
  it('refuses an incomplete draft', () => {
    expect(canPublish(draft(), MIN_PRICE)).toBe(false)
    expect(canPublish(draft({ categoryId: 'c1', propertyId: 'p1' }), MIN_PRICE)).toBe(false)
  })

  it('allows a complete one', () => {
    expect(canPublish(complete(), MIN_PRICE)).toBe(true)
  })

  it('refuses when only the price is missing', () => {
    const almost = complete()
    almost.priceCents = null
    expect(canPublish(almost, MIN_PRICE)).toBe(false)
  })
})

describe('resuming a dropped draft', () => {
  it('opens on the first incomplete step, not back at the beginning', () => {
    // A customer who got three steps in and lost the app should not have to
    // redo them.
    expect(resumeAt(draft(), MIN_PRICE)).toBe('WHAT')
    expect(resumeAt(draft({ categoryId: 'c1' }), MIN_PRICE)).toBe('WHERE')
    expect(resumeAt(draft({ categoryId: 'c1', propertyId: 'p1' }), MIN_PRICE)).toBe('WHEN')
  })

  it('opens on the review step for a finished draft', () => {
    expect(resumeAt(complete(), MIN_PRICE)).toBe('PRICE')
  })

  it('reopens an expired deadline rather than silently publishing it', () => {
    // A draft left overnight has a stale "today" — publishing it would create a
    // job that is already overdue.
    const stale = complete()
    stale.dueAt = new Date(Date.now() - 3_600_000)
    expect(resumeAt(stale, MIN_PRICE)).toBe('WHEN')
  })
})

describe('deadline presets', () => {
  it('offers Today in the morning', () => {
    const morning = new Date()
    morning.setHours(9, 0, 0, 0)
    expect(availablePresets(morning).map((p) => p.key)).toContain('TODAY')
  })

  it('withdraws Today once it is too late to do the work', () => {
    // Offering it at 8pm produces a job nobody can claim, which burns the
    // customer and wastes a worker's tap.
    const evening = new Date()
    evening.setHours(LATEST_HOUR_TO_OFFER_TODAY + 2, 0, 0, 0)
    expect(availablePresets(evening).map((p) => p.key)).not.toContain('TODAY')
    // The other options survive.
    expect(availablePresets(evening).map((p) => p.key)).toContain('TOMORROW')
  })

  it('resolves presets to a sensible hour', () => {
    const now = new Date('2026-06-15T14:00:00')
    const today = DEADLINE_PRESETS.find((p) => p.key === 'TODAY')!
    const resolved = today.resolve!(now)
    // Nobody wants a mower running after dark.
    expect(resolved.getHours()).toBe(19)
    expect(resolved.getDate()).toBe(now.getDate())
  })

  it('resolves Tomorrow to the following day', () => {
    const now = new Date('2026-06-15T14:00:00')
    const tomorrow = DEADLINE_PRESETS.find((p) => p.key === 'TOMORROW')!.resolve!(now)
    expect(tomorrow.getTime()).toBeGreaterThan(now.getTime())
    expect(tomorrow.getDate()).toBe(16)
  })

  it('always resolves to a future time', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date()
      now.setHours(hour, 30, 0, 0)
      for (const preset of availablePresets(now)) {
        if (!preset.resolve) continue
        expect(
          preset.resolve(now).getTime(),
          `${preset.key} at ${hour}:30 resolved to the past`,
        ).toBeGreaterThan(now.getTime())
      }
    }
  })
})

describe('price feedback', () => {
  it('praises a price at the top of the range', () => {
    const feedback = priceFeedback(8500, guidance)
    expect(feedback.tone).toBe('good')
    expect(feedback.claimLikelihood).toBeGreaterThanOrEqual(0.9)
  })

  it('warns honestly about under-pricing, with a number', () => {
    // A customer whose job sits unclaimed concludes the app is broken rather
    // than that they offered too little.
    const feedback = priceFeedback(2500, guidance)
    expect(feedback.tone).toBe('low')
    expect(feedback.message).toMatch(/\d+%/)
    expect(feedback.message).toMatch(/below the local rate/i)
  })

  it('never lowers the estimate as the price rises', () => {
    let previous = 0
    for (let price = 2000; price <= 15_000; price += 250) {
      const likelihood = priceFeedback(price, guidance).claimLikelihood
      expect(likelihood).toBeGreaterThanOrEqual(previous)
      previous = likelihood
    }
  })

  it('starts the input in the middle of the range, rounded to $5', () => {
    const start = suggestedStartingPrice(guidance)
    expect(start).toBe(6500)
    expect(start % 500).toBe(0)
    expect(start).toBeGreaterThanOrEqual(guidance.suggestedLowCents)
    expect(start).toBeLessThanOrEqual(guidance.suggestedHighCents)
  })
})

describe('cost breakdown', () => {
  it('shows the full amount before publishing', () => {
    // A fee discovered on a receipt rather than before the decision earns a
    // chargeback and a one-star review at the same time.
    const cost = costBreakdown(6000, 800, 299)
    expect(cost.jobPriceCents).toBe(6000)
    expect(cost.serviceFeeCents).toBe(480)
    expect(cost.totalCents).toBe(6480)
  })

  it('applies the fee floor on small jobs', () => {
    const cost = costBreakdown(2500, 800, 299)
    expect(cost.serviceFeeCents).toBe(299)
    expect(cost.totalCents).toBe(2799)
  })

  it('always adds up', () => {
    for (let price = 2500; price <= 50_000; price += 137) {
      const cost = costBreakdown(price, 800, 299)
      expect(cost.jobPriceCents + cost.serviceFeeCents).toBe(cost.totalCents)
      expect(Number.isInteger(cost.totalCents)).toBe(true)
    }
  })

  it('matches what the server would charge', () => {
    // Same defaults as DEFAULT_FEE_CONFIG; a mismatch here means the customer
    // is quoted one number and charged another.
    expect(costBreakdown(6000, 800, 299).totalCents).toBe(6480)
    expect(costBreakdown(8500, 800, 299).totalCents).toBe(9180)
  })
})

describe('duration estimate', () => {
  it('scales sublinearly with yard size', () => {
    const small = estimatedMinutesFor(category, 'UNDER_QUARTER_ACRE')
    const medium = estimatedMinutesFor(category, 'QUARTER_TO_HALF')
    const large = estimatedMinutesFor(category, 'OVER_TWO')

    expect(small).toBeLessThan(medium)
    expect(medium).toBeLessThan(large)
    // Eight times the acreage is not eight times the work — setup and teardown
    // do not scale with lot size.
    expect(large).toBeLessThan(medium * 8)
  })

  it('falls back to the category baseline with no yard size', () => {
    expect(estimatedMinutesFor(category, null)).toBe(category.baseMinutes)
  })

  it('never returns an absurdly short estimate', () => {
    expect(estimatedMinutesFor({ ...category, baseMinutes: 5 }, 'UNDER_QUARTER_ACRE'))
      .toBeGreaterThanOrEqual(15)
  })
})
