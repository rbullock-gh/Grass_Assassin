import { describe, expect, it } from 'vitest'
import { JOB_STATUSES } from '@grassassassin/shared'
import {
  customerStatus, customerActions, isLiveForCustomer, autoApproveNotice, tipOptions, TIP_PERCENTS,
  jobSubtitle,
} from '@/lib/customer-jobs'

describe('customer status wording', () => {
  it('covers every status the server can produce', () => {
    // The failure this prevents: the server gains a status, the customer sees
    // "UPDATING" forever, and nobody notices until someone complains.
    for (const status of JOB_STATUSES) {
      expect(customerStatus(status).pill, status).not.toBe('UPDATING')
    }
  })

  it('degrades honestly on a status this build has never heard of', () => {
    expect(customerStatus('TELEPORTED').pill).toBe('UPDATING')
    expect(customerStatus('TELEPORTED').needsYou).toBe(false)
  })

  it('never leaks a raw enum into customer-facing copy', () => {
    for (const status of JOB_STATUSES) {
      expect(customerStatus(status).label).not.toMatch(/_/)
      expect(customerStatus(status).label).not.toBe(status)
    }
  })

  it('hides the payment reservation from the customer entirely', () => {
    // CLAIM_PENDING_PAYMENT is an implementation detail of the claim race. From
    // the customer's side nothing has happened yet.
    expect(customerStatus('CLAIM_PENDING_PAYMENT').label).toBe(customerStatus('POSTED').label)
  })

  it('flags only the statuses genuinely blocked on the customer', () => {
    const needsYou = JOB_STATUSES.filter((status) => customerStatus(status).needsYou)
    expect(needsYou).toEqual(['DRAFT', 'PENDING_APPROVAL'])
  })

  it('treats in-flight work as live and settled work as not', () => {
    expect(isLiveForCustomer({ status: 'IN_PROGRESS' })).toBe(true)
    expect(isLiveForCustomer({ status: 'POSTED' })).toBe(true)
    expect(isLiveForCustomer({ status: 'PAID' })).toBe(false)
    expect(isLiveForCustomer({ status: 'CANCELLED' })).toBe(false)
  })
})

describe('customer actions', () => {
  it('offers approval on exactly one status', () => {
    const approvable = JOB_STATUSES.filter((status) => customerActions(status).canApprove)
    expect(approvable).toEqual(['PENDING_APPROVAL'])
  })

  it('never offers cancellation once work has started', () => {
    // Cancelling mid-mow is a dispute, not a button. And cancelling something
    // already paid is nonsense that would strand the ledger.
    for (const status of ['IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DISPUTED']) {
      expect(customerActions(status).canCancel, status).toBe(false)
    }
  })

  it('allows cancellation right up to the moment work starts', () => {
    for (const status of ['POSTED', 'CLAIMED', 'EN_ROUTE']) {
      expect(customerActions(status).canCancel, status).toBe(true)
    }
  })

  it('never solicits a tip while the worker can still be marked down', () => {
    // A tip prompt on PENDING_APPROVAL is pressure dressed as generosity.
    expect(customerActions('PENDING_APPROVAL').canTip).toBe(false)
    expect(customerActions('IN_PROGRESS').canTip).toBe(false)
    expect(customerActions('PAID').canTip).toBe(true)
  })

  it('stops asking for a rating once one is given', () => {
    expect(customerActions('PAID', false).canRate).toBe(true)
    expect(customerActions('PAID', true).canRate).toBe(false)
  })

  it('only offers recurring service on finished work', () => {
    expect(customerActions('POSTED').canMakeRecurring).toBe(false)
    expect(customerActions('IN_PROGRESS').canMakeRecurring).toBe(false)
    expect(customerActions('CLOSED').canMakeRecurring).toBe(true)
  })
})

describe('auto-approval notice', () => {
  const now = new Date('2026-09-14T12:00:00Z')

  it('says nothing when nothing is pending', () => {
    expect(autoApproveNotice(null, now)).toBeNull()
  })

  it('counts down in hours while there is more than one left', () => {
    const deadline = new Date('2026-09-15T05:00:00Z').toISOString()
    expect(autoApproveNotice(deadline, now)).toBe(
      'Approves automatically in 17 hours if you do not review it.')
  })

  it('switches to minutes inside the last hour', () => {
    const deadline = new Date('2026-09-14T12:40:00Z').toISOString()
    expect(autoApproveNotice(deadline, now)).toBe(
      'Approves automatically in 40 minutes if you do not review it.')
  })

  it('never renders a negative or zero countdown', () => {
    const passed = new Date('2026-09-14T11:00:00Z').toISOString()
    const notice = autoApproveNotice(passed, now)!
    expect(notice).not.toMatch(/-/)
    expect(notice).toBe('This will be approved automatically at any moment.')
  })

  it('singularises one hour and one minute', () => {
    expect(autoApproveNotice(new Date('2026-09-14T13:30:00Z').toISOString(), now))
      .toContain('1 hour ')
    expect(autoApproveNotice(new Date('2026-09-14T12:00:30Z').toISOString(), now))
      .toContain('1 minute ')
  })

  it('ignores a deadline the server sent in a shape we cannot read', () => {
    expect(autoApproveNotice('not a date', now)).toBeNull()
  })
})

describe('tip options', () => {
  it('always offers a visible way to tip nothing', () => {
    // A tip screen with no exit is a dark pattern. It must be a peer of the
    // other options, not buried behind a back gesture.
    const options = tipOptions(9500)
    expect(options[0]).toEqual({ label: 'No tip', amountCents: 0 })
  })

  it('scales with the job rather than offering fixed amounts', () => {
    const small = tipOptions(2500)
    const large = tipOptions(30_000)
    expect(large[2]!.amountCents).toBeGreaterThan(small[2]!.amountCents)
  })

  it('rounds to whole dollars so no button reads like a fee', () => {
    for (const price of [2500, 3300, 4750, 9500, 12_345, 30_000]) {
      for (const option of tipOptions(price)) {
        expect(option.amountCents % 100, `${price} -> ${option.amountCents}`).toBe(0)
      }
    }
  })

  it('never produces a negative tip', () => {
    for (const option of tipOptions(2500)) {
      expect(option.amountCents).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps the presets ordered so the list does not jump around', () => {
    const amounts = tipOptions(9500).map((option) => option.amountCents)
    expect([...amounts].sort((a, b) => a - b)).toEqual(amounts)
    expect(TIP_PERCENTS[0]).toBe(0)
  })
})

describe('job subtitle on the customer home screen', () => {
  const deadline = () => 'Overdue'
  const date = () => 'Sep 12'

  it('never calls a finished job overdue', () => {
    // The bug, caught by a screenshot rather than a test: every non-blocking
    // status got the deadline appended, so a paid job read "Done and paid ·
    // Overdue" — true of the date, alarming nonsense to the person reading it.
    for (const status of ['APPROVED', 'PAID', 'CLOSED']) {
      const line = jobSubtitle({ status, dueAt: '2026-09-01', completedAt: '2026-09-12' }, deadline, date)
      expect(line, status).not.toContain('Overdue')
      expect(line, status).toContain('Sep 12')
    }
  })

  it('still shows the deadline while the work has to happen', () => {
    for (const status of ['POSTED', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS']) {
      expect(jobSubtitle({ status, dueAt: '2026-09-20' }, deadline, date), status).toContain('Overdue')
    }
  })

  it('says nothing about dates on a cancelled or expired job', () => {
    for (const status of ['CANCELLED', 'EXPIRED']) {
      const line = jobSubtitle({ status, dueAt: '2026-09-01' }, deadline, date)
      expect(line, status).not.toContain('Overdue')
      expect(line, status).not.toContain('Sep 12')
    }
  })

  it('leads with the ask when the job is blocked on the customer', () => {
    // "Finished — check the photos and approve" must not be diluted by a date.
    const line = jobSubtitle({ status: 'PENDING_APPROVAL', dueAt: '2026-09-01' }, deadline, date)
    expect(line).toBe('Finished — check the photos and approve')
  })

  it('degrades gracefully when the server sent no completion time', () => {
    const line = jobSubtitle({ status: 'PAID', dueAt: '2026-09-01', completedAt: null }, deadline, date)
    expect(line).toBe('Done and paid')
  })
})
