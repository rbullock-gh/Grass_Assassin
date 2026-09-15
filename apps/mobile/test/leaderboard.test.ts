import { describe, it, expect } from 'vitest'
import { describePeriod, describeFreshness, describeFallback } from '../src/lib/leaderboard'

describe('naming the period', () => {
  it('gives a weekly board its actual dates', () => {
    // The board used to be a rolling 168 hours labelled "This week". Showing
    // the real boundaries is how a worker can tell it resets.
    expect(describePeriod({
      period: 'WEEKLY',
      periodStart: '2026-07-13T00:00:00.000Z',
      periodEnd: '2026-07-20T00:00:00.000Z',
    })).toMatch(/Jul 1[39]/)
  })

  it('ends the week on the last day inside it, not the exclusive bound', () => {
    // periodEnd is exclusive. Printing it raw claims the week runs to the 20th
    // when the 20th is next week's board.
    const text = describePeriod({
      period: 'WEEKLY',
      periodStart: '2026-07-13T00:00:00.000Z',
      periodEnd: '2026-07-20T00:00:00.000Z',
    })
    expect(text).toContain('Jul 19')
    expect(text).not.toContain('Jul 20')
  })

  it('names the month for a monthly board', () => {
    expect(describePeriod({
      period: 'MONTHLY',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    })).toBe('July')
  })

  it('says something for all-time rather than printing 1970', () => {
    expect(describePeriod({
      period: 'ALL_TIME',
      periodStart: '1970-01-01T00:00:00.000Z',
      periodEnd: '9999-01-01T00:00:00.000Z',
    })).toBe('Since the beginning')
  })

  it('returns nothing rather than "Invalid Date" for junk', () => {
    expect(describePeriod({ period: 'WEEKLY', periodStart: 'nope', periodEnd: 'nope' })).toBe('')
  })
})

describe('how fresh the standings are', () => {
  const now = new Date('2026-07-15T12:00:00Z')

  it('says it is current when the server computed it for this request', () => {
    expect(describeFreshness(null, now)).toBe('Up to date')
  })

  it('counts minutes for a recent snapshot', () => {
    expect(describeFreshness('2026-07-15T11:52:00Z', now)).toBe('Updated 8 min ago')
  })

  it('says just now rather than "0 min ago"', () => {
    expect(describeFreshness('2026-07-15T11:59:30Z', now)).toBe('Updated just now')
  })

  it('switches to hours past an hour, and gets the singular right', () => {
    expect(describeFreshness('2026-07-15T11:00:00Z', now)).toBe('Updated 1 hour ago')
    expect(describeFreshness('2026-07-15T09:00:00Z', now)).toBe('Updated 3 hours ago')
  })

  it('gives a date once it is more than a day old', () => {
    expect(describeFreshness('2026-07-12T09:00:00Z', now)).toMatch(/Updated Jul 12/)
  })

  it('does not print "Invalid Date" for junk', () => {
    expect(describeFreshness('not-a-date', now)).toBe('Up to date')
  })
})

describe('saying when the board is not the one that was tapped', () => {
  it('explains a Near me board that fell back to the city', () => {
    const text = describeFallback({ scope: 'CITY', fellBackFrom: 'LOCAL' })
    expect(text).toMatch(/city board/i)
    expect(text).toMatch(/home base/i)
  })

  it('says nothing when nothing fell back', () => {
    expect(describeFallback({ scope: 'LOCAL' })).toBeNull()
    expect(describeFallback({ scope: 'CITY' })).toBeNull()
  })
})
