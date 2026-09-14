/**
 * Job lifecycle state machine.
 *
 * Transitions are enforced on the server. Clients render state; they never decide it.
 * See docs/01-architecture.md §4 for the diagram and the reasoning behind
 * CLAIM_PENDING_PAYMENT.
 */

export const JOB_STATUSES = [
  'DRAFT',
  'POSTED',
  'CLAIM_PENDING_PAYMENT',
  'CLAIMED',
  'EN_ROUTE',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'DISPUTED',
  'APPROVED',
  'PAID',
  'CLOSED',
  'CANCELLED',
  'EXPIRED',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

/** Who is permitted to trigger a transition. */
export type Actor = 'CUSTOMER' | 'WORKER' | 'SYSTEM' | 'ADMIN'

export interface Transition {
  from: JobStatus
  to: JobStatus
  /** Actors allowed to perform this transition. ADMIN is always additionally allowed. */
  actors: Actor[]
  /** Human-readable description, surfaced in audit logs. */
  label: string
}

export const TRANSITIONS: readonly Transition[] = [
  { from: 'DRAFT', to: 'POSTED', actors: ['CUSTOMER'], label: 'Publish job' },
  { from: 'DRAFT', to: 'CANCELLED', actors: ['CUSTOMER'], label: 'Discard draft' },

  // Claim is a two-step reservation: see architecture §5.
  { from: 'POSTED', to: 'CLAIM_PENDING_PAYMENT', actors: ['WORKER'], label: 'Reserve claim' },
  { from: 'POSTED', to: 'CANCELLED', actors: ['CUSTOMER'], label: 'Cancel before claim' },
  { from: 'POSTED', to: 'EXPIRED', actors: ['SYSTEM'], label: 'Deadline passed unclaimed' },

  { from: 'CLAIM_PENDING_PAYMENT', to: 'CLAIMED', actors: ['SYSTEM'], label: 'Payment captured' },
  { from: 'CLAIM_PENDING_PAYMENT', to: 'POSTED', actors: ['SYSTEM'], label: 'Payment failed or reservation expired' },

  { from: 'CLAIMED', to: 'EN_ROUTE', actors: ['WORKER'], label: 'Worker en route' },
  { from: 'CLAIMED', to: 'POSTED', actors: ['WORKER'], label: 'Worker released claim' },
  { from: 'CLAIMED', to: 'CANCELLED', actors: ['CUSTOMER'], label: 'Customer cancelled' },

  { from: 'EN_ROUTE', to: 'IN_PROGRESS', actors: ['WORKER'], label: 'Work started' },
  { from: 'EN_ROUTE', to: 'CLAIMED', actors: ['WORKER'], label: 'Worker reverted en route' },
  { from: 'EN_ROUTE', to: 'CANCELLED', actors: ['CUSTOMER'], label: 'Customer cancelled (fee applies)' },

  { from: 'IN_PROGRESS', to: 'PENDING_APPROVAL', actors: ['WORKER'], label: 'Work completed' },

  { from: 'PENDING_APPROVAL', to: 'APPROVED', actors: ['CUSTOMER'], label: 'Customer approved' },
  { from: 'PENDING_APPROVAL', to: 'APPROVED', actors: ['SYSTEM'], label: 'Auto-approved after window' },
  { from: 'PENDING_APPROVAL', to: 'DISPUTED', actors: ['CUSTOMER'], label: 'Customer reported a problem' },

  { from: 'DISPUTED', to: 'APPROVED', actors: ['ADMIN'], label: 'Dispute resolved for worker' },
  { from: 'DISPUTED', to: 'CANCELLED', actors: ['ADMIN'], label: 'Dispute resolved for customer' },

  { from: 'APPROVED', to: 'PAID', actors: ['SYSTEM'], label: 'Funds transferred to worker' },
  { from: 'PAID', to: 'CLOSED', actors: ['SYSTEM'], label: 'Both parties rated or window elapsed' },
] as const

/** Statuses from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['CLOSED', 'CANCELLED', 'EXPIRED']

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** A job in one of these states occupies a worker and blocks re-claiming. */
export const ACTIVE_CLAIM_STATUSES: readonly JobStatus[] = [
  'CLAIM_PENDING_PAYMENT',
  'CLAIMED',
  'EN_ROUTE',
  'IN_PROGRESS',
  'PENDING_APPROVAL',
  'DISPUTED',
]

/** Statuses where a job is visible on the worker map / job search. */
export const CLAIMABLE_STATUSES: readonly JobStatus[] = ['POSTED']

export function canTransition(from: JobStatus, to: JobStatus, actor: Actor): boolean {
  if (actor === 'ADMIN') {
    // Admins may perform any defined transition, but may not invent undefined ones.
    return TRANSITIONS.some((t) => t.from === from && t.to === to)
  }
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor))
}

export function allowedTransitions(from: JobStatus, actor: Actor): JobStatus[] {
  return TRANSITIONS.filter(
    (t) => t.from === from && (actor === 'ADMIN' || t.actors.includes(actor)),
  ).map((t) => t.to)
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
    readonly actor: Actor,
  ) {
    super(`${actor} cannot move job from ${from} to ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

export function assertTransition(from: JobStatus, to: JobStatus, actor: Actor): void {
  if (!canTransition(from, to, actor)) throw new InvalidTransitionError(from, to, actor)
}

/** Customer may still edit instructions before the worker physically starts. */
export function canEditInstructions(status: JobStatus): boolean {
  return ['DRAFT', 'POSTED', 'CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE'].includes(status)
}

/** Chat opens once a worker is committed, and stays open through dispute resolution. */
export function isChatOpen(status: JobStatus): boolean {
  return ['CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'DISPUTED', 'APPROVED', 'PAID'].includes(
    status,
  )
}
