import { describe, it, expect } from 'vitest'
import { whyNotPayable, payoutStateLabel, describeArrival } from '../src/lib/payouts'
import type { PayoutReadiness } from '@grassassassin/client'

const ready = (over: Partial<PayoutReadiness> = {}): PayoutReadiness => ({
  onboarded: true,
  payoutsEnabled: true,
  chargesEnabled: true,
  requirementsDue: [],
  availableBalanceCents: 5_000,
  pendingBalanceCents: 0,
  minimumPayoutCents: 100,
  ...over,
})

describe('why a worker cannot withdraw', () => {
  it('says nothing is wrong when everything is in order', () => {
    expect(whyNotPayable(ready())).toBeNull()
  })

  it('asks an un-onboarded worker to set up payouts', () => {
    const blocker = whyNotPayable(ready({ onboarded: false, payoutsEnabled: false }))
    expect(blocker?.action).toBe('onboard')
    expect(blocker?.detail).toMatch(/never sees your account number/i)
  })

  it('tells someone in review to wait, not to start again', () => {
    // Sending a worker back through onboarding they already finished is how you
    // get two abandoned attempts and a support ticket.
    const blocker = whyNotPayable(ready({ payoutsEnabled: false }))
    expect(blocker?.action).toBe('wait')
    expect(blocker?.heading).toMatch(/review/i)
  })

  it('sends them back to finish when the provider still wants something', () => {
    const blocker = whyNotPayable(ready({
      payoutsEnabled: false, requirementsDue: ['individual.id_number'],
    }))
    expect(blocker?.action).toBe('onboard')
  })

  it('explains an empty balance by what is pending', () => {
    const blocker = whyNotPayable(ready({ availableBalanceCents: 0, pendingBalanceCents: 8_000 }))
    expect(blocker?.detail).toMatch(/still pending/i)
  })

  it('tells a worker with nothing at all to go find work', () => {
    const blocker = whyNotPayable(ready({ availableBalanceCents: 0 }))
    expect(blocker?.action).toBe('earn')
    expect(blocker?.detail).toMatch(/finish a job/i)
  })

  it('names the minimum rather than refusing silently', () => {
    const blocker = whyNotPayable(ready({ availableBalanceCents: 50, minimumPayoutCents: 100 }))
    expect(blocker?.detail).toContain('$1.00')
  })

  it('checks onboarding before balance, because that is the order of the work', () => {
    // A worker who has not onboarded AND has no balance should be told to
    // onboard. Leading with "nothing to withdraw" hides the step that matters.
    const blocker = whyNotPayable(ready({
      onboarded: false, payoutsEnabled: false, availableBalanceCents: 0,
    }))
    expect(blocker?.action).toBe('onboard')
  })
})

describe('payout state in plain words', () => {
  it.each([
    ['PAID', 'Landed'],
    ['IN_TRANSIT', 'On its way'],
    ['PENDING', 'Sending'],
    ['FAILED', 'Did not go through'],
    ['CANCELLED', 'Cancelled'],
  ])('renders %s as "%s"', (status, expected) => {
    expect(payoutStateLabel(status)).toBe(expected)
  })

  it('falls back to the raw value rather than showing nothing', () => {
    expect(payoutStateLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
})

describe('when the money arrives', () => {
  const now = new Date('2026-06-15T12:00:00Z')

  it('says today for an arrival today', () => {
    expect(describeArrival('2026-06-15T20:00:00Z', now)).toBe('Arriving today.')
  })

  it('says tomorrow rather than "in 1 days"', () => {
    expect(describeArrival('2026-06-16T09:00:00Z', now)).toBe('Arriving tomorrow.')
  })

  it('counts days inside a week', () => {
    expect(describeArrival('2026-06-18T09:00:00Z', now)).toBe('Arriving in 3 days.')
  })

  it('gives a date once it is further out', () => {
    expect(describeArrival('2026-07-02T09:00:00Z', now)).toMatch(/Arriving Jul 2/)
  })

  it('falls back to the usual estimate when there is no date', () => {
    expect(describeArrival(null, now)).toMatch(/two business days/i)
  })

  it('does not print "Invalid Date" when the value is junk', () => {
    const text = describeArrival('not-a-date', now)
    expect(text).not.toMatch(/invalid/i)
    expect(text).toMatch(/two business days/i)
  })
})
