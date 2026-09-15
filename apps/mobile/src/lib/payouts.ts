import type { PayoutReadiness } from '@grassassassin/client'

/**
 * Deciding what to tell a worker about their money.
 *
 * Kept out of the screen so it can be tested without a renderer. The decisions
 * here are the ones that matter: a worker who cannot withdraw needs to be told
 * precisely which step is missing, because "payouts unavailable" is
 * indistinguishable from the platform keeping their money.
 */

export interface PayoutBlocker {
  heading: string
  detail: string
  action: 'onboard' | 'wait' | 'earn'
  actionLabel: string
}

/**
 * Why this worker cannot withdraw right now, or null if they can.
 *
 * The order is deliberate — it follows what the worker has to do next, not the
 * order the flags happen to sit in. Someone who has not started onboarding is
 * told to start it, not that their balance is too small.
 */
export function whyNotPayable(status: PayoutReadiness): PayoutBlocker | null {
  if (!status.onboarded) {
    return {
      heading: 'ONE STEP LEFT',
      detail:
        'Add your bank details to get paid. Our payment provider collects them directly — ' +
        'GrassAssassin never sees your account number.',
      action: 'onboard',
      actionLabel: 'Set up payouts',
    }
  }

  if (!status.payoutsEnabled) {
    return {
      heading: 'BEING REVIEWED',
      detail:
        status.requirementsDue.length > 0
          ? 'Your payment provider needs a bit more before money can move. It usually takes a few minutes.'
          : 'Your details are being checked. This is usually quick, and your earnings keep adding up meanwhile.',
      action: status.requirementsDue.length > 0 ? 'onboard' : 'wait',
      actionLabel: 'Finish setup',
    }
  }

  if (status.availableBalanceCents <= 0) {
    return {
      heading: 'NOTHING TO WITHDRAW YET',
      detail:
        status.pendingBalanceCents > 0
          ? 'Your earnings are still pending. They move here once the customer approves the work.'
          : 'Finish a job and your earnings will land here.',
      action: 'earn',
      actionLabel: 'Find work',
    }
  }

  if (status.availableBalanceCents < status.minimumPayoutCents) {
    const minimum = `$${(status.minimumPayoutCents / 100).toFixed(2)}`
    return {
      heading: 'ALMOST THERE',
      detail: `Withdrawals start at ${minimum}. Your balance keeps growing until then.`,
      action: 'earn',
      actionLabel: 'Find work',
    }
  }

  return null
}

/** Plain words for a payout state. Nobody outside this codebase says IN_TRANSIT. */
export function payoutStateLabel(status: string): string {
  switch (status) {
    case 'PAID': return 'Landed'
    case 'IN_TRANSIT': return 'On its way'
    case 'PENDING': return 'Sending'
    case 'FAILED': return 'Did not go through'
    case 'CANCELLED': return 'Cancelled'
    default: return status
  }
}

/**
 * When the money arrives, in a sentence.
 *
 * A date with no framing invites the reading "it is stuck"; saying it is on the
 * way costs nothing and is what someone actually wants to know.
 */
export function describeArrival(arrivalDate: string | Date | null, now = new Date()): string {
  if (!arrivalDate) return 'Usually two business days.'

  const date = arrivalDate instanceof Date ? arrivalDate : new Date(arrivalDate)
  if (Number.isNaN(date.getTime())) return 'Usually two business days.'

  const days = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000)

  if (days <= 0) return 'Arriving today.'
  if (days === 1) return 'Arriving tomorrow.'
  if (days <= 7) return `Arriving in ${days} days.`

  return `Arriving ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
