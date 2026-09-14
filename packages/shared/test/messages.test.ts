import { describe, expect, it } from 'vitest'
import {
  screenMessage, conversationIsOpen, closedReason, MESSAGE_WINDOW_DAYS_AFTER_END,
} from '../src/domain/messages.js'

describe('message screening', () => {
  it('never blocks — a flagged message still goes through', () => {
    // The whole design. Blocking pushes the conversation to SMS, which is the
    // exact leak the check exists to stop.
    const result = screenMessage('call me at 615-555-0123')
    expect(result.flagged).toBe(true)
    expect(result.notice).toContain('Sent.')
  })

  it('catches a phone number however it is spaced', () => {
    for (const body of [
      'call 6155550123', 'call 615-555-0123', 'call (615) 555-0123',
      'call 615.555.0123', 'call +1 615 555 0123', 'my cell is 615 555 0123',
    ]) {
      expect(screenMessage(body).reasons, body).toContain('PHONE_NUMBER')
    }
  })

  it('catches digits spelled out', () => {
    // The obvious next move once a numeric check exists.
    expect(screenMessage('six one five five five five zero one two three').reasons)
      .toContain('PHONE_NUMBER')
  })

  it('does NOT flag a price as a phone number', () => {
    // These conversations are about a job, at a price. A false positive here
    // fires on the most ordinary message in the product.
    for (const body of ['$120.00 for front and back', 'I can do it for 150 dollars', '$1,200.00 total']) {
      expect(screenMessage(body).reasons, body).not.toContain('PHONE_NUMBER')
    }
  })

  it('does NOT flag a street address as a phone number', () => {
    for (const body of ['I am at 1200 N Lamar Blvd', 'the house is 742 Evergreen Terrace']) {
      expect(screenMessage(body).reasons, body).not.toContain('PHONE_NUMBER')
    }
  })

  it('leaves ordinary job talk completely alone', () => {
    for (const body of [
      'On my way, about 15 minutes out',
      'Gate code is 4417, the dog is friendly',
      'Finished — photos are up. Let me know if you want the hedge done too.',
      'Can you do the back as well? Happy to pay more.',
      'Do you take cash?',
    ]) {
      const result = screenMessage(body)
      expect(result.flagged, `${body} -> ${result.reasons}`).toBe(false)
      expect(result.notice).toBeNull()
    }
  })

  it('catches an email however it is obfuscated', () => {
    for (const body of ['me@example.com', 'me (at) example (dot) com', 'me at example dot com']) {
      expect(screenMessage(body).reasons, body).toContain('EMAIL_ADDRESS')
    }
  })

  it('catches payment handles, which is how an off-platform deal gets paid', () => {
    for (const body of ['venmo me', 'I have Cash App', 'zelle works', 'paypal?']) {
      expect(screenMessage(body).reasons, body).toContain('PAYMENT_HANDLE')
    }
  })

  it('catches proposals to leave the platform', () => {
    for (const body of [
      'lets do this off the app', 'can we skip the fee', 'I can pay you directly',
      'text me at', 'cash in hand next time',
    ]) {
      expect(screenMessage(body).reasons, body).toContain('OFF_PLATFORM')
    }
  })

  it('tells the sender what THEY lose, not what we lose', () => {
    // A notice that reads as a threat teaches people to evade the check.
    const notice = screenMessage('venmo me instead').notice!
    expect(notice).toContain('payment protection')
    expect(notice).not.toMatch(/violat|banned|prohibited|terms of service/i)
  })

  it('reports every reason, not just the first', () => {
    const result = screenMessage('venmo me at 615-555-0123, or email me@example.com')
    expect(result.reasons.sort()).toEqual(['EMAIL_ADDRESS', 'PAYMENT_HANDLE', 'PHONE_NUMBER'])
  })

  it('handles an empty message without throwing', () => {
    expect(screenMessage('').flagged).toBe(false)
  })
})

describe('conversation window', () => {
  const now = new Date('2026-09-14T12:00:00Z')

  it('is open while the job is running', () => {
    for (const status of ['CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'PAID']) {
      expect(conversationIsOpen({ jobStatus: status, jobEndedAt: null, closedAt: null, now }), status).toBe(true)
    }
  })

  it('stays open for a week after the job ends', () => {
    // A gate left open, a missed spot, a question about a tip — the messages
    // that matter most arrive after the work does.
    const ended = new Date(now.getTime() - 3 * 86_400_000)
    expect(conversationIsOpen({ jobStatus: 'CLOSED', jobEndedAt: ended, closedAt: null, now })).toBe(true)
  })

  it('closes once the window has passed', () => {
    const ended = new Date(now.getTime() - (MESSAGE_WINDOW_DAYS_AFTER_END + 1) * 86_400_000)
    expect(conversationIsOpen({ jobStatus: 'CLOSED', jobEndedAt: ended, closedAt: null, now })).toBe(false)
  })

  it('lets an admin close a thread immediately, whatever the job says', () => {
    expect(conversationIsOpen({
      jobStatus: 'IN_PROGRESS', jobEndedAt: null, closedAt: new Date(), now,
    })).toBe(false)
  })

  it('stays open when a terminal job has no end timestamp', () => {
    // Locking two people out of a thread they are mid-conversation in, because
    // of a missing column, is the worse failure.
    expect(conversationIsOpen({ jobStatus: 'CANCELLED', jobEndedAt: null, closedAt: null, now })).toBe(true)
  })

  it('explains why a closed thread is read-only', () => {
    expect(closedReason({ jobStatus: 'IN_PROGRESS', jobEndedAt: null, closedAt: null, now })).toBeNull()
    expect(closedReason({ jobStatus: 'IN_PROGRESS', jobEndedAt: null, closedAt: new Date(), now }))
      .toContain('support')
    const old = new Date(now.getTime() - 30 * 86_400_000)
    expect(closedReason({ jobStatus: 'CLOSED', jobEndedAt: old, closedAt: null, now }))
      .toContain('Post a new job')
  })
})
