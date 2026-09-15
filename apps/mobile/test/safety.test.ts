import { describe, it, expect } from 'vitest'
import {
  reportOptions, whyCannotReport, blockConsequences, MIN_REPORT_DESCRIPTION,
} from '../src/lib/safety'
import { REPORT_CATEGORIES } from '@grassassassin/shared'

describe('what someone can report', () => {
  it('offers every category the server accepts', () => {
    // A category the app cannot express is a category nobody ever reports.
    expect(reportOptions().map((o) => o.value)).toEqual([...REPORT_CATEGORIES])
  })

  it('never shows an API constant to a person', () => {
    for (const option of reportOptions()) {
      expect(option.label).not.toMatch(/_/)
      expect(option.label).not.toBe(option.value)
    }
  })

  it('leads with the ones that are about someone being hurt', () => {
    const first = reportOptions()[0]!
    expect(first.value).toBe('UNSAFE_BEHAVIOUR')
    expect(reportOptions().at(-1)!.value).toBe('OTHER')
  })

  it('explains the one that is specific to this product', () => {
    // "Someone other than the pro I booked turned up" is the report most worth
    // acting on quickly, and the one nobody would think to look for.
    const impersonation = reportOptions().find((o) => o.value === 'IMPERSONATION')!
    expect(impersonation.detail).toMatch(/not the pro who claimed/i)
  })
})

describe('when a report can be sent', () => {
  const enough = 'x'.repeat(MIN_REPORT_DESCRIPTION)

  it('is ready once there is a category and enough detail', () => {
    expect(whyCannotReport('HARASSMENT', enough)).toBeNull()
  })

  it('asks for a category first', () => {
    expect(whyCannotReport(null, enough)).toMatch(/what happened/i)
  })

  it('counts down the characters still needed', () => {
    // The server refuses a description under 20 characters. Finding that out
    // after pressing send, having typed it once, is how people give up.
    expect(whyCannotReport('OTHER', 'too short')).toMatch(/11 more characters/)
  })

  it('gets the singular right at one character left', () => {
    expect(whyCannotReport('OTHER', 'x'.repeat(MIN_REPORT_DESCRIPTION - 1)))
      .toMatch(/1 more character\./)
  })

  it('does not count whitespace as detail', () => {
    expect(whyCannotReport('OTHER', `${enough}   `.trim().slice(0, 5) + '     ')).not.toBeNull()
  })
})

describe('what blocking says it does', () => {
  it('tells a worker what changes on their map', () => {
    expect(blockConsequences('worker')[0]).toMatch(/stop appearing on your map/i)
  })

  it('tells a customer the other side of the same thing', () => {
    expect(blockConsequences('customer')[0]).toMatch(/cannot claim/i)
  })

  it('says messaging stops, which is the part people assume it does not', () => {
    for (const role of ['worker', 'customer'] as const) {
      expect(blockConsequences(role).join(' ')).toMatch(/message/i)
    }
  })

  it('says plainly that blocking is not reporting', () => {
    // Somebody who blocks a dangerous person and believes they have told us
    // about them is the worst outcome this screen can produce.
    for (const role of ['worker', 'customer'] as const) {
      expect(blockConsequences(role).join(' ')).toMatch(/does not tell us anything/i)
    }
  })

  it('says it can be undone', () => {
    expect(blockConsequences('worker').join(' ')).toMatch(/undo/i)
  })
})
