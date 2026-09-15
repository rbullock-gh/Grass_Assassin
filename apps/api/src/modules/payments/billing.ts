import type { Db } from '../../lib/prisma.js'
import type { PaymentProvider, PaymentMethodRef } from './provider.js'
import { NotFoundError, ConflictError, ValidationError, PaymentError } from '../../lib/errors.js'
import { postEntry, ACCOUNTS } from './ledger.js'

/**
 * Getting set up to pay, and to be paid.
 *
 * Everything here was implemented on both payment providers and reachable from
 * nowhere. The marketplace could charge a card and credit a worker, but only for
 * accounts whose provider ids had been written straight into the database — which
 * is what the seed and the tests do. A real person signing up had no way to add a
 * card, and a real worker had no way to get their money out. The money moved
 * correctly and the doors into it did not exist.
 *
 * Two rules run through all of it. Card details never reach us: the client talks
 * to the provider directly with a short-lived secret, and we only ever store a
 * reference. And a worker's balance is a cache of the ledger, never the source of
 * truth — a payout writes the ledger entry and the cache in the same transaction
 * so they cannot disagree.
 */

export interface BillingDeps {
  db: Db
  provider: PaymentProvider
}

const MINIMUM_PAYOUT_CENTS = 100

/**
 * Finds or creates this customer's provider-side record.
 *
 * Idempotent by storage rather than by an idempotency key: if we already hold an
 * id we use it. Creating a second customer record for the same person is not an
 * error the provider would reject, which is exactly why it has to be prevented
 * here — two records means saved cards that the charge path cannot see.
 */
async function ensureCustomerRef(deps: BillingDeps, userId: string): Promise<string> {
  const profile = await deps.db.customerProfile.findUnique({
    where: { userId },
    select: { id: true, stripeCustomerId: true, user: { select: { email: true, firstName: true, lastName: true } } },
  })
  if (!profile) throw new NotFoundError('Customer profile')
  if (profile.stripeCustomerId) return profile.stripeCustomerId

  const ref = await deps.provider.createCustomer({
    email: profile.user.email,
    name: [profile.user.firstName, profile.user.lastName].filter(Boolean).join(' ') || undefined,
    metadata: { userId },
  })

  await deps.db.customerProfile.update({
    where: { id: profile.id },
    data: { stripeCustomerId: ref },
  })
  return ref
}

/**
 * Starts the flow that saves a card.
 *
 * Returns a client secret, not a card form. The card number goes from the
 * customer's device to the provider and never passes through this server, which
 * is the only version of this that keeps us out of scope for handling card data
 * at all.
 */
export async function startPaymentMethodSetup(
  deps: BillingDeps,
  userId: string,
): Promise<{ clientSecret: string; setupIntentId: string; customerRef: string }> {
  const customerRef = await ensureCustomerRef(deps, userId)
  const intent = await deps.provider.createSetupIntent(customerRef)
  return { ...intent, customerRef }
}

export interface SavedMethod extends PaymentMethodRef {
  isDefault: boolean
}

export async function listSavedMethods(
  deps: BillingDeps,
  userId: string,
): Promise<{ methods: SavedMethod[]; defaultPaymentMethodId: string | null }> {
  const profile = await deps.db.customerProfile.findUnique({
    where: { userId },
    select: { stripeCustomerId: true, defaultPaymentMethodId: true },
  })
  if (!profile) throw new NotFoundError('Customer profile')

  // No provider record yet means no saved cards. That is an empty list, not an
  // error — a customer who has never added one is in a perfectly normal state.
  if (!profile.stripeCustomerId) return { methods: [], defaultPaymentMethodId: null }

  const methods = await deps.provider.listPaymentMethods(profile.stripeCustomerId)
  return {
    methods: methods.map((m) => ({ ...m, isDefault: m.id === profile.defaultPaymentMethodId })),
    defaultPaymentMethodId: profile.defaultPaymentMethodId,
  }
}

/**
 * Chooses which saved card gets charged.
 *
 * The id is checked against the provider's list for THIS customer before it is
 * stored. Without that check the endpoint accepts any payment method id in
 * existence, and the next job would be charged to a stranger's card — the
 * request says which card, and a request is not evidence of ownership.
 */
export async function setDefaultPaymentMethod(
  deps: BillingDeps,
  userId: string,
  paymentMethodId: string,
): Promise<{ defaultPaymentMethodId: string }> {
  const profile = await deps.db.customerProfile.findUnique({
    where: { userId },
    select: { id: true, stripeCustomerId: true },
  })
  if (!profile) throw new NotFoundError('Customer profile')
  if (!profile.stripeCustomerId) {
    throw new ConflictError('NO_PAYMENT_METHODS', 'Add a card before choosing a default one')
  }

  const owned = await deps.provider.listPaymentMethods(profile.stripeCustomerId)
  if (!owned.some((m) => m.id === paymentMethodId)) {
    throw new NotFoundError('Payment method')
  }

  await deps.db.customerProfile.update({
    where: { id: profile.id },
    data: { defaultPaymentMethodId: paymentMethodId },
  })
  return { defaultPaymentMethodId: paymentMethodId }
}

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

/**
 * Finds or creates the connected account a worker is paid through.
 *
 * Same idempotency-by-storage reasoning as the customer side, with a sharper
 * consequence: a second connected account is one the platform will never pay
 * into, and the worker would complete an onboarding that silently did nothing.
 */
async function ensureConnectedAccount(deps: BillingDeps, userId: string): Promise<string> {
  const profile = await deps.db.workerProfile.findUnique({
    where: { userId },
    select: { id: true, stripeAccountId: true, user: { select: { email: true } } },
  })
  if (!profile) throw new NotFoundError('Worker profile')
  if (profile.stripeAccountId) return profile.stripeAccountId

  const ref = await deps.provider.createConnectedAccount({
    email: profile.user.email,
    country: 'US',
  })
  await deps.db.workerProfile.update({
    where: { id: profile.id },
    data: { stripeAccountId: ref },
  })
  return ref
}

export async function startPayoutOnboarding(
  deps: BillingDeps,
  userId: string,
  urls: { returnUrl: string; refreshUrl: string },
): Promise<{ url: string; accountRef: string }> {
  const accountRef = await ensureConnectedAccount(deps, userId)
  const url = await deps.provider.createAccountOnboardingLink(
    accountRef, urls.returnUrl, urls.refreshUrl,
  )
  return { url, accountRef }
}

export interface PayoutReadiness {
  onboarded: boolean
  payoutsEnabled: boolean
  chargesEnabled: boolean
  requirementsDue: string[]
  availableBalanceCents: number
  pendingBalanceCents: number
  minimumPayoutCents: number
}

/**
 * Asks the provider where the onboarding actually got to, and writes it down.
 *
 * The account.updated webhook keeps this fresh in normal operation. This exists
 * for the moment a worker finishes onboarding and comes straight back to the
 * app: waiting on a webhook there means showing them "not ready yet" seconds
 * after they finished, which reads as the app being broken.
 */
export async function refreshPayoutReadiness(
  deps: BillingDeps,
  userId: string,
): Promise<PayoutReadiness> {
  const profile = await deps.db.workerProfile.findUnique({
    where: { userId },
    select: {
      id: true, stripeAccountId: true, payoutsEnabled: true, chargesEnabled: true,
      availableBalanceCents: true, pendingBalanceCents: true,
    },
  })
  if (!profile) throw new NotFoundError('Worker profile')

  if (!profile.stripeAccountId) {
    return {
      onboarded: false,
      payoutsEnabled: false,
      chargesEnabled: false,
      requirementsDue: [],
      availableBalanceCents: profile.availableBalanceCents,
      pendingBalanceCents: profile.pendingBalanceCents,
      minimumPayoutCents: MINIMUM_PAYOUT_CENTS,
    }
  }

  const status = await deps.provider.getConnectedAccountStatus(profile.stripeAccountId)
  await deps.db.workerProfile.update({
    where: { id: profile.id },
    data: { payoutsEnabled: status.payoutsEnabled, chargesEnabled: status.chargesEnabled },
  })

  return {
    onboarded: status.detailsSubmitted,
    payoutsEnabled: status.payoutsEnabled,
    chargesEnabled: status.chargesEnabled,
    requirementsDue: status.requirementsDue,
    availableBalanceCents: profile.availableBalanceCents,
    pendingBalanceCents: profile.pendingBalanceCents,
    minimumPayoutCents: MINIMUM_PAYOUT_CENTS,
  }
}

export interface WithdrawalResult {
  payoutId: string
  amountCents: number
  status: string
  arrivalDate: Date | null
  remainingBalanceCents: number
}

/**
 * Pays a worker out.
 *
 * The balance is decremented and the ledger entry written inside one
 * transaction, before the provider is called. Doing it the other way round means
 * a successful payout whose balance never went down, and a worker who can
 * withdraw the same money twice — and a duplicate payout is far harder to undo
 * than a failed one, which the payout.failed webhook already puts back.
 *
 * The idempotency key is derived from the worker and the amount within the
 * minute, so a double-tapped button does not send the money twice.
 */
export async function withdrawEarnings(
  deps: BillingDeps,
  params: { userId: string; amountCents?: number; instant?: boolean },
): Promise<WithdrawalResult> {
  const profile = await deps.db.workerProfile.findUnique({
    where: { userId: params.userId },
    select: {
      id: true, stripeAccountId: true, payoutsEnabled: true, availableBalanceCents: true,
    },
  })
  if (!profile) throw new NotFoundError('Worker profile')
  if (!profile.stripeAccountId || !profile.payoutsEnabled) {
    throw new ConflictError(
      'PAYOUTS_NOT_ENABLED',
      'Finish setting up payouts before withdrawing.',
    )
  }

  const amountCents = params.amountCents ?? profile.availableBalanceCents

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ValidationError('A withdrawal must be a positive whole number of cents')
  }
  if (amountCents < MINIMUM_PAYOUT_CENTS) {
    throw new ConflictError(
      'BELOW_MINIMUM',
      `Withdrawals start at $${(MINIMUM_PAYOUT_CENTS / 100).toFixed(2)}.`,
    )
  }
  if (amountCents > profile.availableBalanceCents) {
    throw new ConflictError(
      'INSUFFICIENT_BALANCE',
      'That is more than your available balance.',
    )
  }

  // Reserve first. The conditional updateMany is what makes two simultaneous
  // withdrawals safe: the second one matches no rows and is refused, rather than
  // both reading the same balance and both succeeding.
  const payout = await deps.db.$transaction(async (tx) => {
    const reserved = await tx.workerProfile.updateMany({
      where: { id: profile.id, availableBalanceCents: { gte: amountCents } },
      data: { availableBalanceCents: { decrement: amountCents } },
    })
    if (reserved.count === 0) {
      throw new ConflictError('INSUFFICIENT_BALANCE', 'That is more than your available balance.')
    }

    await postEntry(tx, {
      lines: [
        {
          account: ACCOUNTS.worker(params.userId),
          amountCents: -amountCents,
          memo: 'Withdrawn to bank',
        },
        {
          account: ACCOUNTS.payoutsOut,
          amountCents,
          memo: 'Paid out to worker',
        },
      ],
    })

    return tx.payout.create({
      data: {
        workerProfileId: profile.id,
        amountCents,
        instant: params.instant ?? false,
        status: 'PENDING',
      },
      select: { id: true },
    })
  })

  let result
  try {
    result = await deps.provider.payout({
      accountRef: profile.stripeAccountId,
      amountCents,
      currency: 'usd',
      idempotencyKey: `payout_${profile.id}_${amountCents}_${Math.floor(Date.now() / 60_000)}`,
      instant: params.instant ?? false,
    })
  } catch (error) {
    // The money never left. Put the balance back and mark the attempt failed,
    // rather than leaving a worker short with a PENDING row nothing will resolve.
    await deps.db.$transaction([
      deps.db.workerProfile.update({
        where: { id: profile.id },
        data: { availableBalanceCents: { increment: amountCents } },
      }),
      deps.db.payout.update({
        where: { id: payout.id },
        data: {
          status: 'FAILED',
          failureMessage: error instanceof Error ? error.message : 'Payout failed',
        },
      }),
    ])
    await postEntry(deps.db, {
      lines: [
        { account: ACCOUNTS.payoutsOut, amountCents: -amountCents, memo: 'Payout failed' },
        { account: ACCOUNTS.worker(params.userId), amountCents, memo: 'Returned after failed payout' },
      ],
    })
    throw new PaymentError(
      'PAYOUT_FAILED',
      'That withdrawal did not go through. Your balance is unchanged.',
    )
  }

  const updated = await deps.db.payout.update({
    where: { id: payout.id },
    data: {
      status: result.status === 'paid' ? 'PAID'
        : result.status === 'failed' ? 'FAILED'
          : result.status === 'in_transit' ? 'IN_TRANSIT' : 'PENDING',
      stripePayoutId: result.payoutId,
      arrivalDate: result.arrivalDate ?? null,
      failureMessage: result.failureMessage ?? null,
    },
    select: { id: true, status: true, arrivalDate: true },
  })

  const after = await deps.db.workerProfile.findUniqueOrThrow({
    where: { id: profile.id },
    select: { availableBalanceCents: true },
  })

  return {
    payoutId: updated.id,
    amountCents,
    status: updated.status,
    arrivalDate: updated.arrivalDate,
    remainingBalanceCents: after.availableBalanceCents,
  }
}

export async function listPayouts(deps: BillingDeps, userId: string) {
  const profile = await deps.db.workerProfile.findUnique({
    where: { userId },
    select: { id: true },
  })
  if (!profile) throw new NotFoundError('Worker profile')

  return deps.db.payout.findMany({
    where: { workerProfileId: profile.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, amountCents: true, feeCents: true, status: true,
      instant: true, arrivalDate: true, failureMessage: true, createdAt: true,
    },
  })
}
