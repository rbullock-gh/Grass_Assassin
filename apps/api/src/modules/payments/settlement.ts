import type { Db } from '../../lib/prisma.js'
import { PaymentError, NotFoundError, ConflictError } from '../../lib/errors.js'
import { postEntry, ACCOUNTS } from './ledger.js'
import type { PaymentProvider } from './provider.js'
import { resolvePolicy } from './fee-config.js'
import { resolveCancellation, quoteJob, type JobQuote } from '@grassassassin/shared'

/**
 * Money movement across the job lifecycle.
 *
 * The flow, and why it is shaped this way:
 *
 *   post    → customer saves a payment method (SetupIntent). Nothing is charged.
 *   claim   → the customer is CHARGED and funds sit in the platform balance.
 *   work    → funds are held.
 *   approve → funds TRANSFER to the worker's connected account.
 *   payout  → the worker's balance reaches their bank on their payout schedule.
 *
 * Capturing at claim rather than at completion is the important decision.
 * Stripe authorizations expire in ~7 days, and this marketplace routinely has
 * days between claim and completion — so an authorize-then-capture flow would
 * regularly fail at exactly the moment a worker had already done the work. That
 * is unacceptable: the supply side is the scarce side, and a worker who does a
 * job for nothing does not come back. Capturing at claim shifts the payment
 * risk onto the platform, where it belongs, and we refund in full if the worker
 * never shows.
 *
 * Every mutation carries an idempotency key derived from the job and the
 * operation, so a retried request or a replayed webhook cannot move money twice.
 */

export interface SettlementDeps {
  db: Db
  provider: PaymentProvider
}

function idempotencyKey(jobId: string, operation: string, discriminator = ''): string {
  return `job_${jobId}_${operation}${discriminator ? `_${discriminator}` : ''}`
}

function quoteFromJob(job: {
  priceCents: number
  serviceFeeCents: number
  customerTotalCents: number
  workerCommissionCents: number
  workerPayoutCents: number
}): JobQuote {
  // Read the stored figures rather than recomputing. A job's economics are
  // fixed at publish time; recomputing here would silently re-price a job if an
  // admin changed the commission rate midway through its lifecycle.
  return {
    jobPriceCents: job.priceCents,
    serviceFeeCents: job.serviceFeeCents,
    customerTotalCents: job.customerTotalCents,
    workerCommissionCents: job.workerCommissionCents,
    workerPayoutCents: job.workerPayoutCents,
    platformGrossCents: job.serviceFeeCents + job.workerCommissionCents,
  }
}

// ---------------------------------------------------------------------------
// Charge at claim
// ---------------------------------------------------------------------------

export interface CaptureResult {
  ok: boolean
  transactionId: string
  failureCode?: string
  failureMessage?: string
}

/**
 * Charges the customer for a job a worker has just reserved.
 *
 * Called while the job sits in CLAIM_PENDING_PAYMENT, which only one worker can
 * ever hold. On success the caller promotes the job to CLAIMED; on failure the
 * caller releases the reservation back to POSTED.
 */
export async function captureForClaim(deps: SettlementDeps, params: {
  jobId: string
  workerUserId: string
}): Promise<CaptureResult> {
  const { db, provider } = deps

  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true, status: true, customerId: true,
      priceCents: true, serviceFeeCents: true, customerTotalCents: true,
      workerCommissionCents: true, workerPayoutCents: true,
      customer: { select: { customerProfile: { select: { stripeCustomerId: true, defaultPaymentMethodId: true } } } },
    },
  })
  if (!job) throw new NotFoundError('Job')
  if (job.status !== 'CLAIM_PENDING_PAYMENT') {
    throw new ConflictError('NOT_PENDING_PAYMENT', 'This job is not awaiting payment')
  }

  const profile = job.customer.customerProfile
  if (!profile?.stripeCustomerId || !profile.defaultPaymentMethodId) {
    return {
      ok: false,
      transactionId: '',
      failureCode: 'no_payment_method',
      failureMessage: 'The customer has no payment method on file',
    }
  }

  const key = idempotencyKey(job.id, 'capture')

  // If a previous attempt already succeeded, do not charge again. This is the
  // guard that makes the whole operation safe to retry.
  const prior = await db.transaction.findUnique({ where: { idempotencyKey: key } })
  if (prior?.status === 'SUCCEEDED') {
    return { ok: true, transactionId: prior.id }
  }

  const transaction = prior ?? await db.transaction.create({
    data: {
      jobId: job.id, kind: 'CHARGE', status: 'PENDING',
      amountCents: job.customerTotalCents, idempotencyKey: key,
    },
  })

  const result = await provider.charge({
    customerRef: profile.stripeCustomerId,
    paymentMethodRef: profile.defaultPaymentMethodId,
    amountCents: job.customerTotalCents,
    currency: 'usd',
    idempotencyKey: key,
    description: `GrassAssassin job ${job.id}`,
    metadata: { jobId: job.id, workerId: params.workerUserId },
  })

  if (result.status !== 'succeeded') {
    await db.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'FAILED',
        stripePaymentIntentId: result.paymentIntentId,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
      },
    })
    return {
      ok: false,
      transactionId: transaction.id,
      failureCode: result.failureCode ?? 'charge_failed',
      failureMessage: result.failureMessage ?? 'The payment could not be completed',
    }
  }

  const quote = quoteFromJob(job)

  await db.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'SUCCEEDED',
        stripePaymentIntentId: result.paymentIntentId,
        stripeChargeId: result.chargeId,
      },
    })

    // The customer's money splits three ways the moment it arrives: the service
    // fee is earned immediately, the job price is held in escrow until the work
    // is approved.
    await postEntry(tx, {
      jobId: job.id,
      transactionId: transaction.id,
      lines: [
        { account: ACCOUNTS.customer(job.customerId), amountCents: -quote.customerTotalCents, memo: 'Charged for job' },
        { account: ACCOUNTS.escrow, amountCents: quote.jobPriceCents, memo: 'Held pending approval' },
        { account: ACCOUNTS.platformRevenue, amountCents: quote.serviceFeeCents, memo: 'Customer service fee' },
      ],
    })
  })

  return { ok: true, transactionId: transaction.id }
}

// ---------------------------------------------------------------------------
// Release on approval
// ---------------------------------------------------------------------------

/**
 * Transfers the worker's share once the customer approves (or auto-approval
 * fires).
 *
 * The commission is recognised as revenue here rather than at charge time,
 * because until the work is approved it might still be refunded.
 */
export async function releaseToWorker(deps: SettlementDeps, params: {
  jobId: string
}): Promise<{ ok: boolean; transactionId: string; failureMessage?: string }> {
  const { db, provider } = deps

  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true, status: true, customerId: true, claimedByWorkerId: true,
      priceCents: true, serviceFeeCents: true, customerTotalCents: true,
      workerCommissionCents: true, workerPayoutCents: true,
      transactions: { where: { kind: 'CHARGE', status: 'SUCCEEDED' }, select: { stripeChargeId: true } },
    },
  })
  if (!job) throw new NotFoundError('Job')
  if (!job.claimedByWorkerId) {
    throw new ConflictError('NO_WORKER', 'This job has no assigned worker')
  }

  const worker = await db.workerProfile.findUnique({
    where: { userId: job.claimedByWorkerId },
    select: { id: true, stripeAccountId: true, payoutsEnabled: true },
  })
  if (!worker?.stripeAccountId) {
    throw new ConflictError('WORKER_NOT_PAYABLE', 'The worker has not completed payout setup')
  }

  const key = idempotencyKey(job.id, 'transfer')
  const prior = await db.transaction.findUnique({ where: { idempotencyKey: key } })
  if (prior?.status === 'SUCCEEDED') return { ok: true, transactionId: prior.id }

  const transaction = prior ?? await db.transaction.create({
    data: {
      jobId: job.id, kind: 'TRANSFER', status: 'PENDING',
      amountCents: job.workerPayoutCents, idempotencyKey: key,
    },
  })

  const result = await provider.transfer({
    destinationAccountRef: worker.stripeAccountId,
    amountCents: job.workerPayoutCents,
    currency: 'usd',
    idempotencyKey: key,
    sourceChargeId: job.transactions[0]?.stripeChargeId ?? undefined,
    metadata: { jobId: job.id },
  })

  if (result.status !== 'succeeded') {
    await db.transaction.update({
      where: { id: transaction.id },
      data: { status: 'FAILED', failureMessage: result.failureMessage ?? null },
    })
    return { ok: false, transactionId: transaction.id, failureMessage: result.failureMessage }
  }

  const quote = quoteFromJob(job)

  await db.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: 'SUCCEEDED', stripeTransferId: result.transferId },
    })

    await postEntry(tx, {
      jobId: job.id,
      transactionId: transaction.id,
      lines: [
        { account: ACCOUNTS.escrow, amountCents: -quote.jobPriceCents, memo: 'Released on approval' },
        { account: ACCOUNTS.worker(job.claimedByWorkerId!), amountCents: quote.workerPayoutCents, memo: 'Job earnings' },
        { account: ACCOUNTS.platformRevenue, amountCents: quote.workerCommissionCents, memo: 'Worker commission' },
      ],
    })

    await tx.workerProfile.update({
      where: { id: worker.id },
      data: {
        availableBalanceCents: { increment: quote.workerPayoutCents },
        lifetimeEarningsCents: { increment: quote.workerPayoutCents },
      },
    })
  })

  return { ok: true, transactionId: transaction.id }
}

// ---------------------------------------------------------------------------
// Cancellation and refunds
// ---------------------------------------------------------------------------

export interface CancellationSettlement {
  customerRefundCents: number
  workerCompensationCents: number
  platformRetainedCents: number
  reason: string
}

/**
 * Settles a cancellation according to policy.
 *
 * The split is computed by shared domain code so the app, the web client, and
 * the server all quote the customer the same number before they confirm.
 */
export async function settleCancellation(deps: SettlementDeps, params: {
  jobId: string
  actor: 'CUSTOMER' | 'WORKER'
  marketKey?: string | null
  now?: Date
}): Promise<CancellationSettlement> {
  const { db, provider } = deps
  const now = params.now ?? new Date()

  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true, status: true, customerId: true, claimedByWorkerId: true, claimedAt: true,
      dueAt: true, windowStartAt: true,
      priceCents: true, serviceFeeCents: true, customerTotalCents: true,
      workerCommissionCents: true, workerPayoutCents: true,
      transactions: {
        where: { kind: 'CHARGE', status: 'SUCCEEDED' },
        select: { id: true, stripePaymentIntentId: true },
      },
    },
  })
  if (!job) throw new NotFoundError('Job')

  const cancellableStatuses = ['POSTED', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS'] as const
  if (!cancellableStatuses.includes(job.status as typeof cancellableStatuses[number])) {
    throw new ConflictError('NOT_CANCELLABLE', `A job in ${job.status} cannot be cancelled`)
  }

  const policy = await resolvePolicy(db, params.marketKey)
  const quote = quoteFromJob(job)

  const outcome = resolveCancellation({
    quote,
    actor: params.actor,
    status: job.status as 'POSTED' | 'CLAIMED' | 'EN_ROUTE' | 'IN_PROGRESS',
    claimedAt: job.claimedAt,
    scheduledFor: job.windowStartAt ?? job.dueAt,
    now,
    policy: policy.cancellation,
  })

  const charge = job.transactions[0]

  // Nothing was ever captured (cancelled before claim), so there is nothing to
  // move. Recording a refund here would invent money.
  if (!charge) {
    return outcome
  }

  await db.$transaction(async (tx) => {
    if (outcome.customerRefundCents > 0 && charge.stripePaymentIntentId) {
      const key = idempotencyKey(job.id, 'refund')
      const refund = await provider.refund({
        paymentIntentId: charge.stripePaymentIntentId,
        amountCents: outcome.customerRefundCents,
        idempotencyKey: key,
        reason: 'requested_by_customer',
      })

      await tx.transaction.create({
        data: {
          jobId: job.id,
          kind: outcome.customerRefundCents === quote.customerTotalCents ? 'REFUND' : 'PARTIAL_REFUND',
          status: refund.status === 'succeeded' ? 'SUCCEEDED' : refund.status === 'pending' ? 'PENDING' : 'FAILED',
          amountCents: outcome.customerRefundCents,
          stripeRefundId: refund.refundId,
          idempotencyKey: key,
        },
      })
    }

    // Unwind escrow and post the settlement. Lines are assembled so they always
    // net to zero regardless of which branch of the policy applied.
    const lines = [
      { account: ACCOUNTS.escrow, amountCents: -quote.jobPriceCents, memo: 'Cancellation unwind' },
      { account: ACCOUNTS.platformRevenue, amountCents: -quote.serviceFeeCents, memo: 'Service fee reversed' },
      { account: ACCOUNTS.customer(job.customerId), amountCents: outcome.customerRefundCents, memo: outcome.reason },
    ]
    if (outcome.workerCompensationCents > 0 && job.claimedByWorkerId) {
      lines.push({
        account: ACCOUNTS.worker(job.claimedByWorkerId),
        amountCents: outcome.workerCompensationCents,
        memo: 'Cancellation compensation',
      })
    }
    if (outcome.platformRetainedCents > 0) {
      lines.push({
        account: ACCOUNTS.platformRevenue,
        amountCents: outcome.platformRetainedCents,
        memo: 'Retained on cancellation',
      })
    }

    // The customer paid customerTotal; the three outcome components must add
    // back to exactly that. Anything left over is a policy bug, and posting an
    // unbalanced entry would hide it.
    const disbursed = outcome.customerRefundCents + outcome.workerCompensationCents + outcome.platformRetainedCents
    const residual = quote.customerTotalCents - disbursed
    if (residual !== 0) {
      lines.push({ account: ACCOUNTS.platformRevenue, amountCents: residual, memo: 'Cancellation residual' })
    }

    await postEntry(tx, { jobId: job.id, lines })

    if (outcome.workerCompensationCents > 0 && job.claimedByWorkerId) {
      await tx.workerProfile.updateMany({
        where: { userId: job.claimedByWorkerId },
        data: {
          availableBalanceCents: { increment: outcome.workerCompensationCents },
          lifetimeEarningsCents: { increment: outcome.workerCompensationCents },
        },
      })
    }
  })

  return outcome
}

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------

/**
 * Charges a tip and passes 100% of it to the worker.
 *
 * The platform takes nothing from tips. This is a stated public policy: the
 * margin would be trivial and the trust damage would not be.
 */
export async function chargeTip(deps: SettlementDeps, params: {
  jobId: string
  fromUserId: string
  amountCents: number
}): Promise<{ ok: boolean; tipId?: string; failureMessage?: string }> {
  const { db, provider } = deps

  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new PaymentError('A tip must be a positive whole number of cents')
  }

  const job = await db.job.findUnique({
    where: { id: params.jobId },
    select: {
      id: true, customerId: true, claimedByWorkerId: true, status: true,
      customer: { select: { customerProfile: { select: { stripeCustomerId: true, defaultPaymentMethodId: true } } } },
    },
  })
  if (!job) throw new NotFoundError('Job')
  if (job.customerId !== params.fromUserId) {
    throw new ConflictError('NOT_YOUR_JOB', 'Only the customer can tip on this job')
  }
  if (!job.claimedByWorkerId) throw new ConflictError('NO_WORKER', 'This job has no worker to tip')

  const profile = job.customer.customerProfile
  if (!profile?.stripeCustomerId || !profile.defaultPaymentMethodId) {
    return { ok: false, failureMessage: 'No payment method on file' }
  }

  const worker = await db.workerProfile.findUnique({
    where: { userId: job.claimedByWorkerId },
    select: { id: true, stripeAccountId: true },
  })
  if (!worker?.stripeAccountId) {
    return { ok: false, failureMessage: 'The worker cannot receive payments yet' }
  }

  // Discriminated by amount and time so a customer can tip more than once.
  const key = idempotencyKey(job.id, 'tip', `${params.amountCents}_${Date.now()}`)

  const charge = await provider.charge({
    customerRef: profile.stripeCustomerId,
    paymentMethodRef: profile.defaultPaymentMethodId,
    amountCents: params.amountCents,
    currency: 'usd',
    idempotencyKey: key,
    description: `Tip for GrassAssassin job ${job.id}`,
    metadata: { jobId: job.id, kind: 'tip' },
  })

  if (charge.status !== 'succeeded') {
    return { ok: false, failureMessage: charge.failureMessage ?? 'The tip could not be processed' }
  }

  const transfer = await provider.transfer({
    destinationAccountRef: worker.stripeAccountId,
    amountCents: params.amountCents, // 100%. No platform cut, by policy.
    currency: 'usd',
    idempotencyKey: `${key}_transfer`,
    sourceChargeId: charge.chargeId ?? undefined,
    metadata: { jobId: job.id, kind: 'tip' },
  })

  const tip = await db.$transaction(async (tx) => {
    const created = await tx.tip.create({
      data: {
        jobId: job.id,
        fromUserId: params.fromUserId,
        toWorkerId: job.claimedByWorkerId!,
        amountCents: params.amountCents,
        stripePaymentIntentId: charge.paymentIntentId,
      },
    })

    await tx.transaction.create({
      data: {
        jobId: job.id, kind: 'TIP', status: 'SUCCEEDED',
        amountCents: params.amountCents,
        stripePaymentIntentId: charge.paymentIntentId,
        stripeChargeId: charge.chargeId,
        stripeTransferId: transfer.status === 'succeeded' ? transfer.transferId : null,
        idempotencyKey: key,
      },
    })

    await postEntry(tx, {
      jobId: job.id,
      lines: [
        { account: ACCOUNTS.customer(job.customerId), amountCents: -params.amountCents, memo: 'Tip' },
        { account: ACCOUNTS.worker(job.claimedByWorkerId!), amountCents: params.amountCents, memo: 'Tip received' },
      ],
    })

    await tx.workerProfile.update({
      where: { id: worker.id },
      data: {
        availableBalanceCents: { increment: params.amountCents },
        lifetimeEarningsCents: { increment: params.amountCents },
      },
    })

    return created
  })

  return { ok: true, tipId: tip.id }
}
