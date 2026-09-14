import { describe, it, expect } from 'vitest'
import { periodBoundsFor, startOfIsoWeek, startOfMonth } from '../src/domain/periods.js'

describe('startOfIsoWeek', () => {
  it('snaps to Monday midnight UTC', () => {
    // 2026-06-15 is a Monday.
    expect(startOfIsoWeek(new Date('2026-06-15T14:23:00Z')).toISOString()).toBe('2026-06-15T00:00:00.000Z')
    expect(startOfIsoWeek(new Date('2026-06-18T09:00:00Z')).toISOString()).toBe('2026-06-15T00:00:00.000Z')
  })

  it('treats Sunday as the END of the week, not the start', () => {
    // 2026-06-21 is a Sunday; it belongs to the week beginning the 15th.
    expect(startOfIsoWeek(new Date('2026-06-21T23:00:00Z')).toISOString()).toBe('2026-06-15T00:00:00.000Z')
    // Monday the 22nd starts a new week.
    expect(startOfIsoWeek(new Date('2026-06-22T00:01:00Z')).toISOString()).toBe('2026-06-22T00:00:00.000Z')
  })
})

describe('startOfMonth', () => {
  it('snaps to the first of the month', () => {
    expect(startOfMonth(new Date('2026-06-15T14:00:00Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })

  it('handles January without rolling the year back', () => {
    expect(startOfMonth(new Date('2026-01-20T14:00:00Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('periodBoundsFor', () => {
  it('is STABLE across repeated calls within the same period', () => {
    // This is the property that matters structurally: boards are keyed by
    // periodStart, so a start that moves creates a new board on every
    // recomputation instead of updating the existing one.
    const monday = periodBoundsFor('WEEKLY', new Date('2026-06-15T00:05:00Z'))
    const thursday = periodBoundsFor('WEEKLY', new Date('2026-06-18T17:45:00Z'))
    const sunday = periodBoundsFor('WEEKLY', new Date('2026-06-21T23:59:00Z'))

    expect(thursday.start.getTime()).toBe(monday.start.getTime())
    expect(sunday.start.getTime()).toBe(monday.start.getTime())
  })

  it('rolls over to a new window at the period boundary', () => {
    // And it must actually reset — a board that never rolls over is not weekly.
    const thisWeek = periodBoundsFor('WEEKLY', new Date('2026-06-21T23:59:00Z'))
    const nextWeek = periodBoundsFor('WEEKLY', new Date('2026-06-22T00:01:00Z'))
    expect(nextWeek.start.getTime()).toBeGreaterThan(thisWeek.start.getTime())
  })

  it('gives monthly a stable window that rolls at month end', () => {
    const early = periodBoundsFor('MONTHLY', new Date('2026-06-01T00:00:00Z'))
    const late = periodBoundsFor('MONTHLY', new Date('2026-06-30T23:59:00Z'))
    const next = periodBoundsFor('MONTHLY', new Date('2026-07-01T00:00:00Z'))

    expect(late.start.getTime()).toBe(early.start.getTime())
    expect(next.start.getTime()).toBeGreaterThan(early.start.getTime())
    expect(early.end.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('handles a December month boundary', () => {
    const december = periodBoundsFor('MONTHLY', new Date('2026-12-15T00:00:00Z'))
    expect(december.end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('gives all-time a fixed epoch start', () => {
    const a = periodBoundsFor('ALL_TIME', new Date('2026-06-15T00:00:00Z'))
    const b = periodBoundsFor('ALL_TIME', new Date('2029-01-01T00:00:00Z'))
    expect(a.start.getTime()).toBe(0)
    expect(b.start.getTime()).toBe(0)
  })

  it('always has end after start', () => {
    for (const period of ['WEEKLY', 'MONTHLY', 'ALL_TIME'] as const) {
      const bounds = periodBoundsFor(period, new Date('2026-06-15T12:00:00Z'))
      expect(bounds.end.getTime()).toBeGreaterThan(bounds.start.getTime())
    }
  })

  it('never produces a start in the future', () => {
    for (let day = 1; day <= 28; day++) {
      const now = new Date(Date.UTC(2026, 5, day, 13, 0))
      for (const period of ['WEEKLY', 'MONTHLY', 'ALL_TIME'] as const) {
        expect(periodBoundsFor(period, now).start.getTime()).toBeLessThanOrEqual(now.getTime())
      }
    }
  })
})
