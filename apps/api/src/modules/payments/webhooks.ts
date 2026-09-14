import type { Db } from '../../lib/prisma.js'
import type { PaymentProvider } from './provider.js'
import { postEntry, ACCOUNTS } from './ledger.js'
import { releaseReservation } from '../jobs/claim.js'

/**
 * Payment provider webhooks.
 *
 * Several things in a marketplace only ever reach us this way:
 *
 *  · A charge that needed 3D Secure and resolved minutes later.
 *  · A dispute or chargeback, which arrives days after the job closed.
 *  · A connected account becoming able to receive payouts after the worker
 *    finished Stripe's onboarding in a browser we never see.
 *  · A payout that failed because the worker's bank rejected it.
 *
 * Without this, a worker whose onboarding completed would stay unable to claim
 * paid work, and a chargeback would silently leave our books disagreeing with
 * the processor.
 *
 * TWO RULES, both non-negotiable:
 *
 * 1. The signature is verified before anything is read. An unverified webhook
 *    body is attacker-controlled input that moves money.
 * 2. Every event is recorded by provider event id and processed at most once.
 *    Providers retry aggressively — Stripe retries for up to three days — so a
 *    handler that is not idempotent will eventually double-apply.
 */

export interface WebhookDeps {
  db: Db
  provider: PaymentProvider
  webhookSecret: string
}

export type WebhookOutcome =
  | { status: 'processed'; eventId: string; type: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'ignored'; eventId: string; type: string }

export class WebhookSignatureError extends Error {
  readonly code = 'INVALID_SIGNATURE'
  constructor(message = 'Webhook signature verification failed') {
    super(message)
    this.name = 'WebhookSignatureError'
  }
}

/**
 * Handles one webhook delivery.
 *
 * `rawBody` MUST be the exact bytes received. Stripe signs the raw payload, so
 * a JSON parse-and-restringify round trip invalidates the signature — which is
 * why the route disables Fastify's body parser for this path.
 */
export async function handleWebhook(deps: WebhookDeps, params: {
  rawBody: string | Buffer
  signature: string
}): Promise<WebhookOutcome> {
  const { db, provider } = deps

  let event: { id: string; type: string; data: unknown }
  try {
    event = await provider.verifyWebhook(params.rawBody, params.signature, deps.webhookSecret)
  } catch {
    // Never leak why verification failed.
    throw new WebhookSignatureError()
  }

  // Idempotency. A unique constraint on the audit row is what actually enforces
  // at-most-once — checking first and then inserting would race with a
  // concurrent retry of the same delivery.
  try {
    await db.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: `webhook.${event.type}`,
        entityType: 'WebhookEvent',
        entityId: event.id,
        after: { type: event.type } as never,
      },
    })
  } catch {
    // Anything that stops the audit row landing means we have seen this
    // delivery before. Acknowledge and stop.
    return { status: 'duplicate', eventId: event.id }
  }

  const data = (event.data as { object?: Record<string, unknown> })?.object ?? {}

  switch (event.type) {
    case 'payment_intent.succeeded':
      await onPaymentSucceeded(db, data)
      return { status: 'processed', eventId: event.id, type: event.type }

    case 'payment_intent.payment_failed':
      await onPaymentFailed(db, data)
      return { status: 'processed', eventId: event.id, type: event.type }

    case 'charge.dispute.created':
      await onDisputeOpened(db, data)
      return { status: 'processed', eventId: event.id, type: event.type }

    case 'account.updated':
      await onAccountUpdated(db, data)
      return { status: 'processed', eventId: event.id, type: event.type }

    case 'payout.failed':
      await onPayoutFailed(db, data)
      return { status: 'processed', eventId: event.id, type: event.type }

    case 'payout.paid':
      await onPayoutPaid(db, data)
      return { status: 'processed', eventId: event.id, type: event.type }

    default:
      // Unrecognised events are acknowledged, not rejected. Returning an error
      // makes the provider retry an event we will never handle, forever.
      return { status: 'ignored', eventId: event.id, type: event.type }
  }
}

async function onPaymentSucceeded(db: Db, data: Record<string, unknown>): Promise<void> {
  const paymentIntentId = String(data['id'] ?? '')
  if (!paymentIntentId) return

  await db.transaction.updateMany({
    where: { stripePaymentIntentId: paymentIntentId, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'SUCCEEDED', failureCode: null, failureMessage: null },
  })
}

/**
 * A charge that failed asynchronously — typically an off-session payment that
 * needed authentication the customer was never present to give.
 *
 * The job must go back into the pool, or a worker is holding a reservation for
 * work that will never be paid for.
 */
async function onPaymentFailed(db: Db, data: Record<string, unknown>): Promise<void> {
  const paymentIntentId = String(data['id'] ?? '')
  if (!paymentIntentId) return

  const failure = data['last_payment_error'] as { code?: string; message?: string } | undefined

  const transaction = await db.transaction.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, jobId: true },
  })
  if (!transaction) return

  await db.transaction.update({
    where: { id: transaction.id },
    data: {
      status: 'FAILED',
      failureCode: failure?.code ?? 'async_failure',
      failureMessage: failure?.message ?? 'The payment failed after it was submitted',
    },
  })

  if (!transaction.jobId) return

  const job = await db.job.findUnique({
    where: { id: transaction.jobId },
    select: { status: true, claimedByWorkerId: true },
  })
  if (job?.status === 'CLAIM_PENDING_PAYMENT' && job.claimedByWorkerId) {
    await releaseReservation(db, transaction.jobId, job.claimedByWorkerId, 'payment_failed_async')
  }
}

/**
 * A dispute. Flagged for human review, never resolved automatically.
 *
 * The evidence package — geofenced check-in timestamps, before/after photos,
 * the chat transcript — is assembled by a human because the cost of getting it
 * wrong falls on a worker who has already done the work.
 */
async function onDisputeOpened(db: Db, data: Record<string, unknown>): Promise<void> {
  const chargeId = String(data['charge'] ?? '')
  const amountCents = Number(data['amount'] ?? 0)

  const transaction = await db.transaction.findFirst({
    where: { stripeChargeId: chargeId },
    select: { id: true, jobId: true },
  })

  await db.fraudFlag.create({
    data: {
      jobId: transaction?.jobId ?? null,
      signal: 'CHARGEBACK_OPENED',
      severity: 5,
      details: {
        chargeId,
        amountCents,
        reason: String(data['reason'] ?? 'unspecified'),
      } as never,
    },
  })

  if (!transaction?.jobId) return

  await db.transaction.create({
    data: {
      jobId: transaction.jobId,
      kind: 'CHARGEBACK',
      status: 'PENDING',
      amountCents,
      stripeChargeId: chargeId,
    },
  })

  const job = await db.job.findUnique({
    where: { id: transaction.jobId },
    select: { customerId: true },
  })
  if (!job) return

  // The money has left our balance whether or not we contest it, so the ledger
  // must reflect that now rather than when the dispute resolves.
  await postEntry(db, {
    jobId: transaction.jobId,
    lines: [
      { account: ACCOUNTS.platformRevenue, amountCents: -amountCents, memo: 'Chargeback withdrawn' },
      { account: ACCOUNTS.customer(job.customerId), amountCents, memo: 'Chargeback' },
    ],
  })
}

/** A worker finished Stripe onboarding, so they may now be paid. */
async function onAccountUpdated(db: Db, data: Record<string, unknown>): Promise<void> {
  const accountRef = String(data['id'] ?? '')
  if (!accountRef) return

  const payoutsEnabled = data['payouts_enabled'] === true
  const chargesEnabled = data['charges_enabled'] === true

  await db.workerProfile.updateMany({
    where: { stripeAccountId: accountRef },
    data: { payoutsEnabled, chargesEnabled },
  })
}

async function onPayoutFailed(db: Db, data: Record<string, unknown>): Promise<void> {
  const payoutId = String(data['id'] ?? '')
  if (!payoutId) return

  const payout = await db.payout.findUnique({
    where: { stripePayoutId: payoutId },
    select: { id: true, workerProfileId: true, amountCents: true, status: true },
  })
  if (!payout || payout.status === 'FAILED') return

  await db.$transaction(async (tx) => {
    await tx.payout.update({
      where: { id: payout.id },
      data: {
        status: 'FAILED',
        failureMessage: String(data['failure_message'] ?? 'The payout was rejected'),
      },
    })
    // The money never left, so it goes back to the worker's available balance
    // rather than silently vanishing from their app.
    await tx.workerProfile.update({
      where: { id: payout.workerProfileId },
      data: { availableBalanceCents: { increment: payout.amountCents } },
    })
  })
}

async function onPayoutPaid(db: Db, data: Record<string, unknown>): Promise<void> {
  const payoutId = String(data['id'] ?? '')
  if (!payoutId) return

  const arrival = data['arrival_date']
  await db.payout.updateMany({
    where: { stripePayoutId: payoutId },
    data: {
      status: 'PAID',
      ...(typeof arrival === 'number' ? { arrivalDate: new Date(arrival * 1000) } : {}),
    },
  })
}
