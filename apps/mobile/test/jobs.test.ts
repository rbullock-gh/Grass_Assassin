import { describe, it, expect } from 'vitest'
import { formatCents } from '@grassassassin/shared'
import type { MapJob } from '@grassassassin/client'
import {
  sortJobs, applyFilters, countActiveFilters, markerVariantFor, isUrgent,
  formatDeadline, displayPrice, displayMoney, displayRate, yardSizeLabel, EMPTY_FILTERS,
  toggleFilterValue, toggleCategory, setDeadlineFilter, deadlineFilterOf, describeFilters,
  type Filters,
} from '@/lib/jobs'
import { layoutFor } from '@/lib/responsive'

const NOW = new Date('2026-06-15T10:00:00Z')

function job(overrides: Partial<MapJob> = {}): MapJob {
  return {
    id: 'j1', title: 'Mow the lawn', description: null,
    categoryId: 'c1', categoryName: 'Lawn Mowing', categoryIcon: 'mower',
    priceCents: 6000, workerPayoutCents: 5280,
    yardSize: 'QUARTER_TO_HALF', estimatedMinutes: 45, payPerHourCents: 7040,
    difficulty: 'EASY', equipmentProvided: false,
    dueAt: '2026-06-16T23:00:00Z', windowStartAt: null, windowEndAt: null,
    postedAt: '2026-06-15T09:00:00Z',
    approximateLocation: { lat: 36.16, lng: -86.78 },
    distanceMeters: 4000, distanceMiles: 2.49,
    generalArea: 'Nashville, TN',
    customerRating: 4.8, customerCompletedJobs: 10,
    isPremium: false, isFeatured: false,
    ...overrides,
  }
}

describe('sorting', () => {
  it('sorts by distance ascending', () => {
    const jobs = [job({ id: 'far', distanceMeters: 9000 }), job({ id: 'near', distanceMeters: 1000 })]
    expect(sortJobs(jobs, 'DISTANCE').map((j) => j.id)).toEqual(['near', 'far'])
  })

  it('sorts by payout descending', () => {
    const jobs = [job({ id: 'low', workerPayoutCents: 3000 }), job({ id: 'high', workerPayoutCents: 12000 })]
    expect(sortJobs(jobs, 'PAY_DESC').map((j) => j.id)).toEqual(['high', 'low'])
  })

  it('sorts by pay per hour, not raw payout', () => {
    // The whole point of this sort: a $100 three-hour job pays less per hour
    // than a $60 one-hour job, and raw payout misleads a worker into the wrong
    // choice.
    const jobs = [
      job({ id: 'big-slow', workerPayoutCents: 10_000, payPerHourCents: 3333 }),
      job({ id: 'quick', workerPayoutCents: 6000, payPerHourCents: 8000 }),
    ]
    expect(sortJobs(jobs, 'PAY_PER_HOUR').map((j) => j.id)).toEqual(['quick', 'big-slow'])
  })

  it('sorts jobs with no rate estimate last, not first', () => {
    // Treating null as zero would be fine; treating it as "unknown = best"
    // would put every un-estimated job at the top.
    const jobs = [
      job({ id: 'unknown', payPerHourCents: null }),
      job({ id: 'known', payPerHourCents: 5000 }),
    ]
    expect(sortJobs(jobs, 'PAY_PER_HOUR').map((j) => j.id)).toEqual(['known', 'unknown'])
  })

  it('floats featured jobs to the top of every ordering', () => {
    const jobs = [
      job({ id: 'near', distanceMeters: 500 }),
      job({ id: 'featured', distanceMeters: 15_000, isFeatured: true }),
    ]
    for (const sort of ['DISTANCE', 'PAY_DESC', 'NEWEST', 'DUE_SOON', 'PAY_PER_HOUR'] as const) {
      expect(sortJobs(jobs, sort)[0]!.id, `sort ${sort}`).toBe('featured')
    }
  })

  it('never drops or duplicates a job', () => {
    const jobs = Array.from({ length: 20 }, (_, i) =>
      job({ id: `j${i}`, distanceMeters: Math.random() * 20_000, workerPayoutCents: 2000 + i * 300 }))
    for (const sort of ['DISTANCE', 'PAY_DESC', 'NEWEST', 'DUE_SOON', 'PAY_PER_HOUR'] as const) {
      const result = sortJobs(jobs, sort)
      expect(result).toHaveLength(20)
      expect(new Set(result.map((j) => j.id)).size).toBe(20)
    }
  })

  it('does not mutate the input array', () => {
    const jobs = [job({ id: 'a', distanceMeters: 9000 }), job({ id: 'b', distanceMeters: 100 })]
    sortJobs(jobs, 'DISTANCE')
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b'])
  })
})

describe('filters', () => {
  it('returns everything with no filters applied', () => {
    const jobs = [job({ id: 'a' }), job({ id: 'b' })]
    expect(applyFilters(jobs, EMPTY_FILTERS, NOW)).toHaveLength(2)
  })

  it('filters by max distance', () => {
    const jobs = [job({ id: 'near', distanceMeters: 1600 }), job({ id: 'far', distanceMeters: 32_000 })]
    expect(applyFilters(jobs, { maxDistanceMiles: 5 }, NOW).map((j) => j.id)).toEqual(['near'])
  })

  it('filters by minimum payout', () => {
    const jobs = [job({ id: 'low', workerPayoutCents: 2000 }), job({ id: 'high', workerPayoutCents: 9000 })]
    expect(applyFilters(jobs, { minPayoutCents: 5000 }, NOW).map((j) => j.id)).toEqual(['high'])
  })

  it('filters by equipment provided, distinguishing false from unset', () => {
    const jobs = [job({ id: 'provided', equipmentProvided: true }), job({ id: 'byo', equipmentProvided: false })]
    expect(applyFilters(jobs, { equipmentProvided: true }, NOW).map((j) => j.id)).toEqual(['provided'])
    expect(applyFilters(jobs, { equipmentProvided: false }, NOW).map((j) => j.id)).toEqual(['byo'])
    expect(applyFilters(jobs, {}, NOW)).toHaveLength(2)
  })

  it('filters to jobs due today', () => {
    const jobs = [
      job({ id: 'today', dueAt: '2026-06-15T19:00:00Z' }),
      job({ id: 'later', dueAt: '2026-06-20T19:00:00Z' }),
    ]
    expect(applyFilters(jobs, { dueToday: true }, NOW).map((j) => j.id)).toEqual(['today'])
  })

  it('combines filters conjunctively', () => {
    const jobs = [
      job({ id: 'match', distanceMeters: 1600, workerPayoutCents: 9000 }),
      job({ id: 'too-far', distanceMeters: 32_000, workerPayoutCents: 9000 }),
      job({ id: 'too-cheap', distanceMeters: 1600, workerPayoutCents: 2000 }),
    ]
    const result = applyFilters(jobs, { maxDistanceMiles: 5, minPayoutCents: 5000 }, NOW)
    expect(result.map((j) => j.id)).toEqual(['match'])
  })

  it('counts active filters for the chip badge', () => {
    expect(countActiveFilters({})).toBe(0)
    expect(countActiveFilters({ maxDistanceMiles: 10 })).toBe(1)
    expect(countActiveFilters({ maxDistanceMiles: 10, minPayoutCents: 5000, dueToday: true })).toBe(3)
    // An empty category array is not an active filter.
    expect(countActiveFilters({ categoryIds: [] })).toBe(0)
  })
})

describe('marker variants', () => {
  it('marks a job due within six hours as urgent', () => {
    expect(isUrgent('2026-06-15T14:00:00Z', NOW)).toBe(true)
    expect(isUrgent('2026-06-16T14:00:00Z', NOW)).toBe(false)
  })

  it('does not call an already-overdue job urgent', () => {
    expect(isUrgent('2026-06-15T08:00:00Z', NOW)).toBe(false)
  })

  it('lets urgency outrank the commercial signals', () => {
    // A worker missing a deadline costs them points and a customer their
    // afternoon; a missed premium badge costs nothing.
    const urgentPremium = job({ dueAt: '2026-06-15T13:00:00Z', isPremium: true, isFeatured: true })
    expect(markerVariantFor(urgentPremium, NOW)).toBe('urgent')
  })

  it('prefers featured over premium', () => {
    expect(markerVariantFor(job({ isFeatured: true, isPremium: true }), NOW)).toBe('featured')
    expect(markerVariantFor(job({ isPremium: true }), NOW)).toBe('premium')
    expect(markerVariantFor(job(), NOW)).toBe('default')
  })
})

describe('formatting', () => {
  it('shows whole dollars on markers', () => {
    expect(displayPrice(6500)).toBe('$65')
    expect(displayPrice(12_000)).toBe('$120')
  })

  it('phrases deadlines the way a worker thinks about them', () => {
    expect(formatDeadline('2026-06-15T19:00:00Z', NOW)).toMatch(/^Today by/)
    expect(formatDeadline('2026-06-16T19:00:00Z', NOW)).toMatch(/^Tomorrow by/)
    expect(formatDeadline('2026-06-18T19:00:00Z', NOW)).toMatch(/^Thursday by/)
    expect(formatDeadline('2026-06-15T08:00:00Z', NOW)).toBe('Overdue')
  })

  it('formats an hourly rate, or nothing when unknown', () => {
    expect(displayRate(7040)).toBe('$70/hr')
    expect(displayRate(null)).toBeNull()
  })

  it('labels yard sizes readably', () => {
    expect(yardSizeLabel('QUARTER_TO_HALF')).toBe('¼–½ acre')
    expect(yardSizeLabel(null)).toBeNull()
    expect(yardSizeLabel('SOMETHING_ELSE')).toBeNull()
  })
})

describe('responsive layout', () => {
  it('gives a phone a single-pane draggable sheet', () => {
    const layout = layoutFor(390, 844)
    expect(layout.sizeClass).toBe('compact')
    expect(layout.isMultiPane).toBe(false)
    expect(layout.sheetIsPersistent).toBe(false)
    expect(layout.columns).toBe(1)
  })

  it('gives a folded Galaxy Fold the phone layout', () => {
    expect(layoutFor(344, 882).sizeClass).toBe('compact')
  })

  it('gives an unfolded Fold the two-pane layout', () => {
    const layout = layoutFor(906, 882)
    expect(layout.sizeClass).toBe('expanded')
    expect(layout.isMultiPane).toBe(true)
    expect(layout.columns).toBe(2)
  })

  it('gives a tablet two panes and a desktop three', () => {
    expect(layoutFor(1024, 768).columns).toBe(2)
    expect(layoutFor(1440, 900).columns).toBe(3)
    expect(layoutFor(1440, 900).hasDetailPane).toBe(true)
  })

  it('detects phone landscape, which needs map-left/list-right', () => {
    expect(layoutFor(844, 390).isPhoneLandscape).toBe(false) // 844 is medium, not compact
    expect(layoutFor(590, 390).isPhoneLandscape).toBe(true)
  })

  it('never gives a wider screen fewer panes', () => {
    let previous = 0
    for (let width = 320; width <= 2000; width += 17) {
      const columns = layoutFor(width, 900).columns
      expect(columns).toBeGreaterThanOrEqual(previous)
      previous = columns
    }
  })
})

describe('filter controls', () => {
  it('clears a filter when the value already set is tapped again', () => {
    // Without this a mis-tap has no way back except Clear All, which throws
    // away the four filters the worker meant to keep.
    const set = toggleFilterValue(EMPTY_FILTERS, 'maxDistanceMiles', 10)
    expect(set.maxDistanceMiles).toBe(10)
    expect(toggleFilterValue(set, 'maxDistanceMiles', 10).maxDistanceMiles).toBeUndefined()
  })

  it('switches to a different value rather than clearing', () => {
    const set = toggleFilterValue(EMPTY_FILTERS, 'maxDistanceMiles', 10)
    expect(toggleFilterValue(set, 'maxDistanceMiles', 5).maxDistanceMiles).toBe(5)
  })

  it('removes the key entirely rather than leaving undefined behind', () => {
    // countActiveFilters checks `!== undefined`, but a lingering key would
    // still serialise into the query string as an empty value.
    const cleared = toggleFilterValue(
      toggleFilterValue(EMPTY_FILTERS, 'difficulty', 'HARD'), 'difficulty', 'HARD')
    expect('difficulty' in cleared).toBe(false)
    expect(countActiveFilters(cleared)).toBe(0)
  })

  it('handles equipmentProvided:false, which is a real filter and not "unset"', () => {
    // The bug this guards: treating false as absent, so "I bring my own gear"
    // silently does nothing.
    const own = toggleFilterValue(EMPTY_FILTERS, 'equipmentProvided', false)
    expect(own.equipmentProvided).toBe(false)
    expect(countActiveFilters(own)).toBe(1)
    expect(toggleFilterValue(own, 'equipmentProvided', false).equipmentProvided).toBeUndefined()
  })

  it('toggles categories within a list without disturbing the others', () => {
    let f = toggleCategory(EMPTY_FILTERS, 'mow')
    f = toggleCategory(f, 'leaves')
    expect(f.categoryIds).toEqual(['mow', 'leaves'])
    f = toggleCategory(f, 'mow')
    expect(f.categoryIds).toEqual(['leaves'])
  })

  it('drops the category key when the last one is removed', () => {
    const f = toggleCategory(toggleCategory(EMPTY_FILTERS, 'mow'), 'mow')
    expect('categoryIds' in f).toBe(false)
    expect(countActiveFilters(f)).toBe(0)
  })

  it('never lets both deadline filters be set at once', () => {
    // Both set is a contradiction the worker cannot see, and reads as a broken
    // filter that hides everything.
    let f = setDeadlineFilter(EMPTY_FILTERS, 'TODAY')
    expect(f.dueToday).toBe(true)
    f = setDeadlineFilter(f, 'THIS_WEEK')
    expect(f.dueToday).toBeUndefined()
    expect(f.dueThisWeek).toBe(true)
    expect(countActiveFilters(f)).toBe(1)
  })

  it('round-trips the deadline choice', () => {
    for (const choice of ['TODAY', 'THIS_WEEK', null] as const) {
      expect(deadlineFilterOf(setDeadlineFilter(EMPTY_FILTERS, choice))).toBe(choice)
    }
  })

  it('leaves other filters alone when the deadline changes', () => {
    const base = toggleFilterValue(EMPTY_FILTERS, 'minPayoutCents', 5000)
    expect(setDeadlineFilter(base, 'TODAY').minPayoutCents).toBe(5000)
  })
})

describe('filter summary line', () => {
  const names = { mow: 'Lawn Mowing', leaves: 'Leaf Removal' }

  it('says "All jobs" when nothing is filtered', () => {
    expect(describeFilters(EMPTY_FILTERS)).toBe('All jobs')
  })

  it('names the categories when it knows them', () => {
    expect(describeFilters({ categoryIds: ['mow', 'leaves'] }, names)).toBe('Lawn Mowing, Leaf Removal')
  })

  it('falls back to a count when a category name has not loaded', () => {
    // The category list loads asynchronously; the summary must not render
    // "undefined" in the window before it arrives.
    const line = describeFilters({ categoryIds: ['mow', 'unknown'] }, names)
    expect(line).toBe('2 categories')
    expect(line).not.toContain('undefined')
  })

  it('distinguishes gear provided from bringing your own', () => {
    expect(describeFilters({ equipmentProvided: true })).toBe('gear provided')
    expect(describeFilters({ equipmentProvided: false })).toBe('own gear')
  })

  it('never renders both deadlines', () => {
    expect(describeFilters({ dueToday: true, dueThisWeek: true })).toBe('due today')
  })

  it('reads as one line with everything set', () => {
    expect(describeFilters({
      maxDistanceMiles: 10, minPayoutCents: 5000, categoryIds: ['mow'],
      difficulty: 'HARD', equipmentProvided: true, dueToday: true,
    }, names)).toBe('within 10 mi · $50.00+ · Lawn Mowing · hard · gear provided · due today')
  })

  it('agrees with the active-filter count on what counts as set', () => {
    const cases: Filters[] = [
      {}, { maxDistanceMiles: 5 }, { equipmentProvided: false },
      { difficulty: 'EASY', dueThisWeek: true }, { minPayoutCents: 2000, categoryIds: ['mow'] },
    ]
    for (const f of cases) {
      const described = describeFilters(f, names)
      const parts = described === 'All jobs' ? 0 : described.split(' · ').length
      expect(parts, JSON.stringify(f)).toBe(countActiveFilters(f))
    }
  })
})

describe('money formatting', () => {
  it('never shows a worker more money than they have', () => {
    // The bug this replaced: displayPrice ROUNDS, so $3,527.60 available
    // rendered as "$3,528". On a balance that is a lie in the worst direction.
    expect(displayMoney(352_760)).toBe('$3,527.60')
    expect(displayMoney(352_740)).toBe('$3,527.40')
  })

  it('keeps every cent', () => {
    expect(displayMoney(1)).toBe('$0.01')
    expect(displayMoney(99)).toBe('$0.99')
    expect(displayMoney(100)).toBe('$1.00')
    expect(displayMoney(8360)).toBe('$83.60')
  })

  it('separates thousands so a balance is readable at a glance', () => {
    expect(displayMoney(100_000_00)).toBe('$100,000.00')
    expect(displayMoney(123_456_789)).toBe('$1,234,567.89')
  })

  it('handles zero and negatives without mangling the sign', () => {
    // A negative balance is a real state after a refund or a chargeback.
    expect(displayMoney(0)).toBe('$0.00')
    expect(displayMoney(-2500)).toBe('-$25.00')
    expect(displayMoney(-1)).toBe('-$0.01')
  })

  it('agrees with the server on any amount the server would format', () => {
    // The app and the receipt must not disagree about a number, ever.
    for (const cents of [0, 1, 99, 100, 2500, 8360, 99_999, 123_456_789]) {
      expect(displayMoney(cents).replace(/,/g, ''), String(cents)).toBe(formatCents(cents))
    }
  })

  it('keeps displayPrice compact for markers, where a glance is the point', () => {
    expect(displayPrice(9500)).toBe('$95')
    expect(displayPrice(12_000)).toBe('$120')
  })
})
