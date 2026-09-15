import { describe, expect, it } from 'vitest'
import {
  DISPUTE_REASONS, disputeReason, isUrgentDispute, validateDispute, canDispute,
  withinDisputeWindow, DISPUTE_WINDOW_DAYS, MIN_DISPUTE_DESCRIPTION,
} from '../src/domain/disputes.js'
import { JOB_STATUSES } from '../src/domain/job-status.js'

describe('the reasons offered', () => {
  it('explains each one, so the customer picks the right category', () => {
    // A dispute filed under the wrong reason is routed wrong and judged wrong.
    for (const reason of DISPUTE_REASONS) {
      expect(reason.help.length, reason.key).toBeGreaterThan(20)
    }
  })

  it('treats damage, wrong property and safety as urgent — and nothing else', () => {
    // One is an insurance matter and one may involve someone getting hurt on
    // private property. A patchy mow is not worth waking anyone up for.
    const urgent = DISPUTE_REASONS.filter((r) => r.urgent).map((r) => r.key).sort()
    expect(urgent).toEqual(['PROPERTY_DAMAGE', 'SAFETY', 'WRONG_PROPERTY'])
  })

  it('has an escape hatch so nobody is forced into a wrong category', () => {
    expect(disputeReason('OTHER')).toBeDefined()
    expect(isUrgentDispute('OTHER')).toBe(false)
  })

  it('treats an unknown reason as not urgent rather than throwing', () => {
    expect(isUrgentDispute('MADE_UP')).toBe(false)
  })
})

describe('validating a report', () => {
  const good = { reason: 'POOR_QUALITY', description: 'The back half of the lawn was not cut at all.' }

  it('accepts an ordinary report', () => {
    expect(validateDispute(good)).toEqual({ ok: true })
  })

  it('refuses a reason that is not on the list', () => {
    expect(validateDispute({ ...good, reason: 'I_JUST_DONT_LIKE_IT' }).error).toBe('Choose what went wrong')
  })

  it('refuses an empty description', () => {
    expect(validateDispute({ ...good, description: '   ' }).error).toBe('Tell us what happened')
  })

  it('refuses a description too short to act on', () => {
    // "bad" is not a case an admin can adjudicate.
    expect(validateDispute({ ...good, description: 'bad' }).error).toContain('sentence or two')
    expect(validateDispute({ ...good, description: 'x'.repeat(MIN_DISPUTE_DESCRIPTION - 1) }).ok).toBe(false)
    expect(validateDispute({ ...good, description: 'x'.repeat(MIN_DISPUTE_DESCRIPTION) }).ok).toBe(true)
  })

  it('refuses one longer than the column can hold', () => {
    expect(validateDispute({ ...good, description: 'x'.repeat(2001) }).ok).toBe(false)
  })

  it('measures the trimmed description, not the padding', () => {
    expect(validateDispute({ ...good, description: `   ${'x'.repeat(5)}   ` }).ok).toBe(false)
  })
})

describe('when a dispute may be raised', () => {
  it('only once the work is claimed finished', () => {
    // Before that the remedy is to cancel, which is cheaper for everyone. A
    // dispute raised before any work happened is a cancellation in costume.
    const disputable = JOB_STATUSES.filter(canDispute)
    expect(disputable).toEqual(['PENDING_APPROVAL', 'APPROVED', 'PAID'])
  })

  it('is still possible after payment', () => {
    // The money has moved, but an admin can still refund — and a customer who
    // discovers the problem the next morning is the common case.
    expect(canDispute('PAID')).toBe(true)
  })

  it('is not possible on a cancelled or expired job', () => {
    expect(canDispute('CANCELLED')).toBe(false)
    expect(canDispute('EXPIRED')).toBe(false)
  })
})

describe('the reporting window', () => {
  const now = new Date('2026-09-20T12:00:00Z')

  it('is open while the job is not yet finished', () => {
    expect(withinDisputeWindow(null, now)).toBe(true)
  })

  it('is open the day after', () => {
    expect(withinDisputeWindow(new Date('2026-09-19T12:00:00Z'), now)).toBe(true)
  })

  it('closes after two weeks, because the evidence is gone by then', () => {
    // Grass grows back. A complaint about a mow three weeks later cannot be
    // judged by anyone.
    const old = new Date(now.getTime() - (DISPUTE_WINDOW_DAYS + 1) * 86_400_000)
    expect(withinDisputeWindow(old, now)).toBe(false)
  })

  it('is inclusive of the final day', () => {
    const edge = new Date(now.getTime() - DISPUTE_WINDOW_DAYS * 86_400_000)
    expect(withinDisputeWindow(edge, now)).toBe(true)
  })
})
