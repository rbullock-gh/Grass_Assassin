import { describe, it, expect } from 'vitest'
import { endOfLocalDay, endOfLocalWeek } from '../src/domain/deadlines.js'

/**
 * "Due today" must mean today where the WORKER is, not where the server is.
 *
 * The original implementation used the server's local time, so a worker in
 * Honolulu querying a UTC server would be shown jobs due tomorrow morning their
 * time as "today", and would miss jobs actually due later today.
 */
describe('endOfLocalDay', () => {
  it('ends the day at local midnight for a UTC viewer', () => {
    const now = new Date('2026-06-15T10:00:00Z')
    expect(endOfLocalDay(now, 0).toISOString()).toBe('2026-06-15T23:59:59.999Z')
  })

  it('ends the day later in UTC for a viewer west of UTC', () => {
    // Honolulu is UTC-10, so getTimezoneOffset() reports 600.
    const now = new Date('2026-06-15T10:00:00Z') // midnight local in Honolulu
    const end = endOfLocalDay(now, 600)
    // Their day ends at 23:59:59.999 local = 09:59:59.999 UTC the NEXT day.
    expect(end.toISOString()).toBe('2026-06-16T09:59:59.999Z')
    expect(end.getTime()).toBeGreaterThan(now.getTime())
  })

  it('ends the day earlier in UTC for a viewer east of UTC', () => {
    // Sydney is UTC+10 in June, so getTimezoneOffset() reports -600.
    const now = new Date('2026-06-15T02:00:00Z') // noon local in Sydney
    const end = endOfLocalDay(now, -600)
    expect(end.toISOString()).toBe('2026-06-15T13:59:59.999Z')
  })

  it('is always in the future relative to now, across every offset', () => {
    // If this ever went backwards, the "today" filter would return nothing at
    // all — which is exactly the failure that surfaced this bug.
    for (let offset = -720; offset <= 720; offset += 30) {
      for (const hour of [0, 6, 12, 18, 23]) {
        const now = new Date(Date.UTC(2026, 5, 15, hour, 30))
        const end = endOfLocalDay(now, offset)
        expect(
          end.getTime(),
          `offset ${offset}, ${hour}:30 UTC produced an end-of-day in the past`,
        ).toBeGreaterThan(now.getTime())
      }
    }
  })

  it('never reaches more than 24 hours out', () => {
    for (let offset = -720; offset <= 720; offset += 30) {
      const now = new Date(Date.UTC(2026, 5, 15, 12, 0))
      const end = endOfLocalDay(now, offset)
      expect(end.getTime() - now.getTime()).toBeLessThanOrEqual(86_400_000)
    }
  })

  it('handles a job due four hours out as "today" in most of the world', () => {
    // The concrete case that failed: a job posted at 20:35 UTC due at 00:35 UTC
    // is still "today" for anyone west of UTC, which is all of the Americas.
    const now = new Date('2026-06-15T20:35:00Z')
    const dueIn4h = new Date(now.getTime() + 4 * 3_600_000)

    expect(dueIn4h <= endOfLocalDay(now, 300)).toBe(true) // New York
    expect(dueIn4h <= endOfLocalDay(now, 360)).toBe(true) // Nashville / Chicago
    expect(dueIn4h <= endOfLocalDay(now, 480)).toBe(true) // Los Angeles
    // And correctly NOT today for a UTC viewer, since it falls after midnight.
    expect(dueIn4h <= endOfLocalDay(now, 0)).toBe(false)
  })
})

describe('endOfLocalWeek', () => {
  it('reaches seven local days out', () => {
    const now = new Date('2026-06-15T10:00:00Z')
    const end = endOfLocalWeek(now, 0)
    expect(end.toISOString()).toBe('2026-06-21T23:59:59.999Z')
  })

  it('is always later than the end of today', () => {
    for (let offset = -720; offset <= 720; offset += 60) {
      const now = new Date(Date.UTC(2026, 5, 15, 9, 0))
      expect(endOfLocalWeek(now, offset).getTime()).toBeGreaterThan(endOfLocalDay(now, offset).getTime())
    }
  })
})
