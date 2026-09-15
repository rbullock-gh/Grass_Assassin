import { describe, it, expect } from 'vitest'
import {
  intervalLabel, scheduleState, nextRunSentence, pauseUntil, PAUSE_OPTIONS, INTERVALS,
} from '../src/lib/recurring'

/**
 * Telling somebody what their standing arrangement is about to do.
 *
 * The screen these feed did not exist: a customer could start a weekly service
 * and had no way to see it, pause it or stop it. Everything here is about the
 * question that matters — am I about to be charged, and when.
 */

const sub = (over: Partial<Parameters<typeof nextRunSentence>[0]> = {}) => ({
  active: true,
  pausedUntil: null,
  nextRunAt: '2026-07-20T09:00:00Z',
  priceCents: 6000,
  ...over,
})

const NOW = new Date('2026-07-15T12:00:00Z')

describe('what state a schedule is in', () => {
  it('is active when it is running', () => {
    expect(scheduleState(sub(), NOW)).toBe('active')
  })

  it('is cancelled when it is switched off', () => {
    expect(scheduleState(sub({ active: false }), NOW)).toBe('cancelled')
  })

  it('is paused while the pause is still in the future', () => {
    expect(scheduleState(sub({ pausedUntil: '2026-08-01T00:00:00Z' }), NOW)).toBe('paused')
  })

  it('is active again once the pause has passed', () => {
    // A pause that expired is not a pause. Showing "paused" after the date
    // would tell somebody nothing is coming when a job is about to be posted.
    expect(scheduleState(sub({ pausedUntil: '2026-07-01T00:00:00Z' }), NOW)).toBe('active')
  })

  it('treats cancelled as cancelled even if a pause is also set', () => {
    expect(scheduleState(sub({ active: false, pausedUntil: '2026-08-01T00:00:00Z' }), NOW))
      .toBe('cancelled')
  })
})

describe('the sentence that says what happens next', () => {
  it('counts down the days and names the price', () => {
    expect(nextRunSentence(sub(), NOW)).toBe('Next job posts in 5 days, $60.00.')
  })

  it('says tomorrow rather than "in 1 days"', () => {
    expect(nextRunSentence(sub({ nextRunAt: '2026-07-16T09:00:00Z' }), NOW))
      .toBe('Next job posts tomorrow, $60.00.')
  })

  it('says today when it is today', () => {
    expect(nextRunSentence(sub({ nextRunAt: '2026-07-15T20:00:00Z' }), NOW))
      .toMatch(/today/)
  })

  it('gives a date once it is further out', () => {
    expect(nextRunSentence(sub({ nextRunAt: '2026-09-01T09:00:00Z' }), NOW))
      .toMatch(/Sep 1/)
  })

  it('never shows a next date for a cancelled schedule', () => {
    // Showing a date that will never arrive is how somebody concludes they are
    // still being charged after cancelling.
    const text = nextRunSentence(sub({ active: false }), NOW)
    expect(text).toMatch(/Cancelled/)
    expect(text).not.toMatch(/Next job/)
  })

  it('says when a pause ends rather than when the next job would have been', () => {
    const text = nextRunSentence(sub({ pausedUntil: '2026-08-03T00:00:00Z' }), NOW)
    expect(text).toMatch(/Paused until Aug 3/)
    expect(text).toMatch(/Nothing is booked before then/)
  })

  it('does not print "Invalid Date" for a junk timestamp', () => {
    const text = nextRunSentence(sub({ nextRunAt: 'not-a-date' }), NOW)
    expect(text).not.toMatch(/invalid/i)
    expect(text).toContain('$60.00')
  })
})

describe('the words on screen', () => {
  it('never shows an API constant', () => {
    for (const interval of INTERVALS) {
      expect(intervalLabel(interval.key)).not.toMatch(/_|WEEKLY|MONTHLY/)
    }
  })

  it('falls back to the raw value rather than showing nothing', () => {
    expect(intervalLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })

  it('offers pauses in the lengths people actually take', () => {
    // A holiday, a dry spell, a winter. A date picker makes somebody do
    // arithmetic to express any of those.
    expect(PAUSE_OPTIONS.map((o) => o.days)).toEqual([14, 30, 90])
  })
})

describe('working out when a pause ends', () => {
  it('lands the right number of days out', () => {
    const until = new Date(pauseUntil(14, NOW))
    expect(Math.round((until.getTime() - NOW.getTime()) / 86_400_000)).toBe(14)
  })

  it('produces something the API will accept', () => {
    expect(pauseUntil(30, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
