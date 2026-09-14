import { describe, it, expect } from 'vitest'
import {
  canTransition, assertTransition, allowedTransitions, isTerminal,
  InvalidTransitionError, TRANSITIONS, JOB_STATUSES, canEditInstructions, isChatOpen,
  ACTIVE_CLAIM_STATUSES, type JobStatus,
} from '../src/domain/job-status.js'

describe('job lifecycle state machine', () => {
  it('walks the full happy path', () => {
    const path: Array<[JobStatus, JobStatus, 'CUSTOMER' | 'WORKER' | 'SYSTEM']> = [
      ['DRAFT', 'POSTED', 'CUSTOMER'],
      ['POSTED', 'CLAIM_PENDING_PAYMENT', 'WORKER'],
      ['CLAIM_PENDING_PAYMENT', 'CLAIMED', 'SYSTEM'],
      ['CLAIMED', 'EN_ROUTE', 'WORKER'],
      ['EN_ROUTE', 'IN_PROGRESS', 'WORKER'],
      ['IN_PROGRESS', 'PENDING_APPROVAL', 'WORKER'],
      ['PENDING_APPROVAL', 'APPROVED', 'CUSTOMER'],
      ['APPROVED', 'PAID', 'SYSTEM'],
      ['PAID', 'CLOSED', 'SYSTEM'],
    ]
    for (const [from, to, actor] of path) {
      expect(canTransition(from, to, actor), `${actor}: ${from} -> ${to}`).toBe(true)
    }
  })

  it('refuses to skip the payment reservation step', () => {
    // A worker must not be able to jump straight to CLAIMED; that is the whole
    // point of CLAIM_PENDING_PAYMENT.
    expect(canTransition('POSTED', 'CLAIMED', 'WORKER')).toBe(false)
  })

  it('refuses transitions that skip work entirely', () => {
    expect(canTransition('CLAIMED', 'PENDING_APPROVAL', 'WORKER')).toBe(false)
    expect(canTransition('POSTED', 'PAID', 'SYSTEM')).toBe(false)
    expect(canTransition('CLAIMED', 'CLOSED', 'CUSTOMER')).toBe(false)
  })

  it('stops a worker from approving their own work', () => {
    expect(canTransition('PENDING_APPROVAL', 'APPROVED', 'WORKER')).toBe(false)
    expect(canTransition('PENDING_APPROVAL', 'APPROVED', 'CUSTOMER')).toBe(true)
  })

  it('stops a customer from marking work complete', () => {
    expect(canTransition('IN_PROGRESS', 'PENDING_APPROVAL', 'CUSTOMER')).toBe(false)
    expect(canTransition('IN_PROGRESS', 'PENDING_APPROVAL', 'WORKER')).toBe(true)
  })

  it('allows the system to auto-approve but not to dispute on a user\'s behalf', () => {
    expect(canTransition('PENDING_APPROVAL', 'APPROVED', 'SYSTEM')).toBe(true)
    expect(canTransition('PENDING_APPROVAL', 'DISPUTED', 'SYSTEM')).toBe(false)
  })

  it('lets only an admin resolve a dispute', () => {
    expect(canTransition('DISPUTED', 'APPROVED', 'ADMIN')).toBe(true)
    expect(canTransition('DISPUTED', 'APPROVED', 'CUSTOMER')).toBe(false)
    expect(canTransition('DISPUTED', 'APPROVED', 'WORKER')).toBe(false)
    expect(canTransition('DISPUTED', 'CANCELLED', 'ADMIN')).toBe(true)
  })

  it('does not let admins invent undefined transitions', () => {
    // Admin overrides existing edges; it is not a wildcard that corrupts the model.
    expect(canTransition('DRAFT', 'PAID', 'ADMIN')).toBe(false)
    expect(canTransition('CLOSED', 'POSTED', 'ADMIN')).toBe(false)
  })

  it('treats terminal states as terminal', () => {
    for (const s of ['CLOSED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(isTerminal(s)).toBe(true)
      expect(allowedTransitions(s, 'ADMIN')).toEqual([])
      expect(allowedTransitions(s, 'CUSTOMER')).toEqual([])
    }
  })

  it('returns no outgoing edges from any terminal status', () => {
    for (const t of TRANSITIONS) {
      expect(isTerminal(t.from), `${t.from} is terminal but has an outgoing edge to ${t.to}`).toBe(false)
    }
  })

  it('has no unreachable non-initial status', () => {
    const reachable = new Set<JobStatus>(['DRAFT'])
    let grew = true
    while (grew) {
      grew = false
      for (const t of TRANSITIONS) {
        if (reachable.has(t.from) && !reachable.has(t.to)) {
          reachable.add(t.to)
          grew = true
        }
      }
    }
    for (const s of JOB_STATUSES) {
      expect(reachable.has(s), `${s} is unreachable from DRAFT`).toBe(true)
    }
  })

  it('throws a typed error with useful context', () => {
    expect(() => assertTransition('POSTED', 'PAID', 'WORKER')).toThrow(InvalidTransitionError)
    try {
      assertTransition('POSTED', 'PAID', 'WORKER')
    } catch (e) {
      const err = e as InvalidTransitionError
      expect(err.code).toBe('INVALID_TRANSITION')
      expect(err.from).toBe('POSTED')
      expect(err.to).toBe('PAID')
      expect(err.message).toContain('WORKER')
    }
  })

  it('lets a payment failure return the job to the pool', () => {
    expect(canTransition('CLAIM_PENDING_PAYMENT', 'POSTED', 'SYSTEM')).toBe(true)
  })

  it('opens instruction editing only before work physically starts', () => {
    expect(canEditInstructions('POSTED')).toBe(true)
    expect(canEditInstructions('EN_ROUTE')).toBe(true)
    expect(canEditInstructions('IN_PROGRESS')).toBe(false)
    expect(canEditInstructions('PENDING_APPROVAL')).toBe(false)
  })

  it('opens chat from claim through payment, including disputes', () => {
    expect(isChatOpen('POSTED')).toBe(false)
    expect(isChatOpen('CLAIMED')).toBe(true)
    expect(isChatOpen('DISPUTED')).toBe(true)
    expect(isChatOpen('CLOSED')).toBe(false)
  })

  it('counts every in-flight status as occupying the worker', () => {
    // Anything between reservation and resolution must block re-claiming.
    for (const s of ['CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'DISPUTED'] as const) {
      expect(ACTIVE_CLAIM_STATUSES).toContain(s)
    }
    expect(ACTIVE_CLAIM_STATUSES).not.toContain('POSTED')
    expect(ACTIVE_CLAIM_STATUSES).not.toContain('CLOSED')
  })
})
