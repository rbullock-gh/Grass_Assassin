import type { JobSummary } from '@grassassassin/client'

/**
 * Translating job status for the person who is paying.
 *
 * The server's state machine has thirteen statuses because it needs them; a
 * customer needs to know one of three things — is someone coming, do I need to
 * do something, or is it finished. So this collapses the machine rather than
 * leaking it, and the wording is what a person would say out loud. Nobody
 * standing in their kitchen thinks "my job is PENDING_APPROVAL".
 *
 * Kept pure and out of the component so the mapping is testable and so the web
 * client gets the same words.
 */

export type CustomerTone = 'waiting' | 'live' | 'done' | 'ended'

export interface CustomerStatus {
  /** Sentence-shaped, for the body of a card. */
  label: string
  /** Two or three words, for a pill. */
  pill: string
  tone: CustomerTone
  /** The job is blocked on the customer — surfaced above everything else. */
  needsYou: boolean
}

const STATUSES: Record<string, CustomerStatus> = {
  DRAFT: { label: 'Not posted yet', pill: 'DRAFT', tone: 'waiting', needsYou: true },
  POSTED: { label: 'Waiting for a pro to claim it', pill: 'FINDING A PRO', tone: 'waiting', needsYou: false },
  // The customer has no idea what a payment reservation is, and does not need
  // to: from their side this is still "finding a pro".
  CLAIM_PENDING_PAYMENT: { label: 'Waiting for a pro to claim it', pill: 'FINDING A PRO', tone: 'waiting', needsYou: false },
  CLAIMED: { label: 'A pro has claimed it', pill: 'SCHEDULED', tone: 'live', needsYou: false },
  EN_ROUTE: { label: 'Your pro is on the way', pill: 'ON THE WAY', tone: 'live', needsYou: false },
  IN_PROGRESS: { label: 'Work is underway', pill: 'IN PROGRESS', tone: 'live', needsYou: false },
  PENDING_APPROVAL: { label: 'Finished — check the photos and approve', pill: 'NEEDS YOU', tone: 'live', needsYou: true },
  DISPUTED: { label: 'You reported a problem. We are looking into it.', pill: 'IN REVIEW', tone: 'live', needsYou: false },
  APPROVED: { label: 'Approved — paying your pro', pill: 'APPROVED', tone: 'done', needsYou: false },
  PAID: { label: 'Done and paid', pill: 'COMPLETE', tone: 'done', needsYou: false },
  CLOSED: { label: 'Done and paid', pill: 'COMPLETE', tone: 'done', needsYou: false },
  CANCELLED: { label: 'Cancelled', pill: 'CANCELLED', tone: 'ended', needsYou: false },
  EXPIRED: { label: 'Nobody claimed it before the deadline', pill: 'EXPIRED', tone: 'ended', needsYou: false },
}

const UNKNOWN: CustomerStatus = { label: 'Updating', pill: 'UPDATING', tone: 'waiting', needsYou: false }

export function customerStatus(status: string): CustomerStatus {
  // A status the app does not recognise means the server is ahead of this build.
  // Showing "Updating" is honest; crashing or showing the raw enum is not.
  return STATUSES[status] ?? UNKNOWN
}

/** Jobs still in flight, in the customer's sense of the word. */
export function isLiveForCustomer(job: Pick<JobSummary, 'status'>): boolean {
  const tone = customerStatus(job.status).tone
  return tone === 'waiting' || tone === 'live'
}

/**
 * What the customer can do about this job right now.
 *
 * Returned as data rather than rendered inline so the rules are testable: the
 * expensive mistake here is offering "Cancel" on a job that is already paid, or
 * hiding "Approve" on the one status where it is the entire point of the
 * screen.
 */
export interface CustomerActions {
  canApprove: boolean
  canReportProblem: boolean
  canCancel: boolean
  canRate: boolean
  canTip: boolean
  canMakeRecurring: boolean
}

export function customerActions(status: string, alreadyReviewed = false): CustomerActions {
  const settled = status === 'APPROVED' || status === 'PAID' || status === 'CLOSED'
  return {
    canApprove: status === 'PENDING_APPROVAL',
    canReportProblem: status === 'PENDING_APPROVAL',
    // Cancellable right up to the moment work starts. Once a pro is mowing,
    // cancelling is a dispute, not a button.
    canCancel: ['DRAFT', 'POSTED', 'CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE'].includes(status),
    canRate: settled && !alreadyReviewed,
    // Tips are offered after approval, never before: a tip solicited while the
    // worker can still be marked down is pressure, not generosity.
    canTip: settled,
    canMakeRecurring: settled,
  }
}

/**
 * The approval countdown.
 *
 * Work auto-approves after a window so a worker is not left unpaid by a
 * customer who simply forgot. That is fair, but only if the customer is told —
 * a silent auto-approval that spends their money is the kind of surprise that
 * earns a chargeback.
 *
 * The deadline comes from the server rather than being computed here: the
 * window is admin-configurable per market, so a hardcoded 24 hours would become
 * a lie the first time someone changed it.
 */
export function autoApproveNotice(autoApproveAt: string | Date | null, now = new Date()): string | null {
  if (!autoApproveAt) return null
  const deadline = typeof autoApproveAt === 'string' ? new Date(autoApproveAt) : autoApproveAt
  if (Number.isNaN(deadline.getTime())) return null

  const remainingMs = deadline.getTime() - now.getTime()
  if (remainingMs <= 0) return 'This will be approved automatically at any moment.'

  const hours = Math.floor(remainingMs / 3_600_000)
  if (hours >= 1) {
    return `Approves automatically in ${hours} hour${hours === 1 ? '' : 's'} if you do not review it.`
  }
  const minutes = Math.max(1, Math.round(remainingMs / 60_000))
  return `Approves automatically in ${minutes} minute${minutes === 1 ? '' : 's'} if you do not review it.`
}

/**
 * Tip presets.
 *
 * Percentages of the job price rather than fixed amounts, because $5 on a $25
 * job and $5 on a $300 job mean completely different things. No preset is
 * pre-selected and "No tip" is a first-class option in the same row as the
 * others — a tip screen with no visible way out is a dark pattern, and the
 * brief ruled those out.
 */
export const TIP_PERCENTS = [0, 10, 15, 20] as const

export function tipOptions(priceCents: number): Array<{ label: string; amountCents: number }> {
  return TIP_PERCENTS.map((percent) =>
    percent === 0
      ? { label: 'No tip', amountCents: 0 }
      // Rounded to the dollar: a "$3.75 tip" button reads like a fee.
      : { label: `${percent}%`, amountCents: Math.round((priceCents * percent) / 100 / 100) * 100 },
  )
}
