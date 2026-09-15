/**
 * Reporting a problem with completed work.
 *
 * The job status machine has a DISPUTED state and the admin dashboard is built
 * around an "evidence package", but nothing ever wrote a dispute record — so a
 * customer reporting a problem moved the job to DISPUTED, held the money, and
 * left no case for anyone to answer. The admin opened an empty page while a
 * worker waited to be paid.
 *
 * What a dispute needs is not complicated, and all of it has to be collected at
 * the moment it is raised: what went wrong, in the customer's own words, and
 * whatever they can show. Asking later means asking someone who has already
 * moved on.
 */

export type DisputeReason =
  | 'NOT_DONE'
  | 'POOR_QUALITY'
  | 'INCOMPLETE'
  | 'PROPERTY_DAMAGE'
  | 'WRONG_PROPERTY'
  | 'SAFETY'
  | 'OTHER'

export interface DisputeReasonOption {
  key: DisputeReason
  label: string
  /** What the customer is told this means, so they pick the right one. */
  help: string
  /**
   * Routed to a person immediately rather than sitting in the queue.
   *
   * Damage and safety are not quality complaints — one is an insurance matter
   * and the other may involve somebody getting hurt on private property. Both
   * are worth waking someone up for; a patchy mow is not.
   */
  urgent: boolean
}

export const DISPUTE_REASONS: readonly DisputeReasonOption[] = [
  {
    key: 'NOT_DONE',
    label: 'The work was not done',
    help: 'Nothing was done, or the pro never arrived.',
    urgent: false,
  },
  {
    key: 'INCOMPLETE',
    label: 'Only part of it was done',
    help: 'Some of what you asked for was missed.',
    urgent: false,
  },
  {
    key: 'POOR_QUALITY',
    label: 'The quality was poor',
    help: 'It was done, but not to a standard you can accept.',
    urgent: false,
  },
  {
    key: 'PROPERTY_DAMAGE',
    label: 'Something was damaged',
    help: 'Damage to your property, plants, or belongings.',
    urgent: true,
  },
  {
    key: 'WRONG_PROPERTY',
    label: 'The wrong property was worked on',
    help: 'The pro worked on a neighbour’s yard, or the wrong part of yours.',
    urgent: true,
  },
  {
    key: 'SAFETY',
    label: 'A safety or conduct concern',
    help: 'Anything about how the pro behaved, or that someone was put at risk.',
    urgent: true,
  },
  {
    key: 'OTHER',
    label: 'Something else',
    help: 'Tell us what happened and a person will read it.',
    urgent: false,
  },
] as const

export function disputeReason(key: string): DisputeReasonOption | undefined {
  return DISPUTE_REASONS.find((reason) => reason.key === key)
}

export function isUrgentDispute(key: string): boolean {
  return disputeReason(key)?.urgent ?? false
}

/**
 * How much the customer has to write.
 *
 * Enough that an admin has something to act on — "bad" is not a case — and
 * short enough that a frustrated person will actually finish it. Twenty
 * characters is about one honest sentence.
 */
export const MIN_DISPUTE_DESCRIPTION = 20
export const MAX_DISPUTE_DESCRIPTION = 2000

export interface DisputeValidation {
  ok: boolean
  error?: string
}

export function validateDispute(input: { reason: string; description: string }): DisputeValidation {
  if (!disputeReason(input.reason)) return { ok: false, error: 'Choose what went wrong' }

  const description = input.description.trim()
  if (description.length === 0) return { ok: false, error: 'Tell us what happened' }
  if (description.length < MIN_DISPUTE_DESCRIPTION) {
    return { ok: false, error: 'A sentence or two, so we can actually look into it' }
  }
  if (description.length > MAX_DISPUTE_DESCRIPTION) {
    return { ok: false, error: `Keep it under ${MAX_DISPUTE_DESCRIPTION} characters` }
  }
  return { ok: true }
}

/**
 * Which job statuses a customer may dispute from.
 *
 * Only after the work is claimed finished. Before that the customer's remedy is
 * to cancel, which is cheaper for everyone than opening a case — and a dispute
 * raised before any work happened is a cancellation wearing a costume.
 */
export const DISPUTABLE_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PAID'] as const

export function canDispute(jobStatus: string): boolean {
  return (DISPUTABLE_STATUSES as readonly string[]).includes(jobStatus)
}

/**
 * How long after payment a dispute can still be raised.
 *
 * A window, because evidence decays: grass grows back, and a complaint about a
 * mow three weeks later cannot be judged by anyone. Long enough that a customer
 * who was away when the work happened is not shut out.
 */
export const DISPUTE_WINDOW_DAYS = 14

export function withinDisputeWindow(completedAt: Date | null, now = new Date()): boolean {
  if (completedAt === null) return true
  return now.getTime() - completedAt.getTime() <= DISPUTE_WINDOW_DAYS * 86_400_000
}
