import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob,
} from '../../../test/factories.js'
import { FakePaymentProvider } from './fake-provider.js'
import { captureForClaim, resolveDispute } from './settlement.js'
import { ledgerIsBalanced, accountBalance, ACCOUNTS } from './ledger.js'
import { attemptClaim } from '../jobs/claim.js'

/**
 * Dispute resolution moves real money in three directions, so every path is
 * checked for the same thing: the customer paid exactly one amount, and what
 * comes back out has to add to exactly that.
 */
const provider = new FakePaymentProvider()
const deps = { db: prisma, provider }

let categoryId: string
let customerId: string
let propertyId: string
let workerUserId: string
let workerProfileId: string

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })

beforeEach(async () => {
  await resetDatabase()
  provider.reset()

  const category = await createCategory()
  const customer = await createCustomer()
  const property = await createProperty(customer.id)
  const worker = await createWorker({ categoryId: category.id })

  categoryId = category.id
  customerId = customer.id
  propertyId = property.id
  workerUserId = worker.user.id
  workerProfileId = worker.profile.id

  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_test_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
  await prisma.workerProfile.update({
    where: { id: workerProfileId },
    data: { stripeAccountId: 'acct_test_1', payoutsEnabled: true, chargesEnabled: true },
  })
})

/** A job taken all the way to a paid-for, disputed state. */
async function disputedJob(priceCents = 10_000) {
  const job = await createJob({ customerId, propertyId, categoryId, priceCents, status: 'POSTED' })
  await attemptClaim(prisma, { jobId: job.id, workerUserId })
  await captureForClaim(deps, { jobId: job.id, workerUserId })
  await prisma.job.update({ where: { id: job.id }, data: { status: 'DISPUTED' } })

  const dispute = await prisma.dispute.create({
    data: {
      jobId: job.id,
      openedById: customerId,
      againstId: workerUserId,
      reason: 'INCOMPLETE',
      description: 'The back half of the lawn was not cut at all.',
      status: 'OPEN',
    },
    select: { id: true },
  })

  const loaded = await prisma.job.findUniqueOrThrow({
    where: { id: job.id },
    select: { customerTotalCents: true, workerPayoutCents: true, priceCents: true, serviceFeeCents: true },
  })
  return { jobId: job.id, disputeId: dispute.id, ...loaded }
}

describe('resolving for the worker', () => {
  it('pays the worker and refunds nothing', async () => {
    const job = await disputedJob()
    const result = await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'WORKER',
      resolution: 'Before and after photos show the work was done.',
      resolvedById: customerId,
    })

    expect(result.customerRefundCents).toBe(0)
    expect(result.workerPaidCents).toBe(job.workerPayoutCents)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('credits the worker balance', async () => {
    const job = await disputedJob()
    await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'WORKER',
      resolution: 'Evidence supports the pro.', resolvedById: customerId,
    })
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.availableBalanceCents).toBe(job.workerPayoutCents)
  })
})

describe('resolving for the customer', () => {
  it('refunds everything and pays the worker nothing', async () => {
    const job = await disputedJob()
    const result = await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'CUSTOMER',
      resolution: 'No after photos and the customer sent their own showing uncut grass.',
      resolvedById: customerId,
    })

    expect(result.customerRefundCents).toBe(job.customerTotalCents)
    expect(result.workerPaidCents).toBe(0)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('refunds the service fee too, not just the job price', async () => {
    // The customer got nothing. Keeping our fee on a job that did not happen is
    // how a refund becomes a second complaint.
    const job = await disputedJob()
    const result = await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'CUSTOMER',
      resolution: 'Work not done.', resolvedById: customerId,
    })
    expect(result.customerRefundCents).toBe(job.priceCents + job.serviceFeeCents)
  })

  it('leaves the worker balance untouched', async () => {
    const job = await disputedJob()
    await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'CUSTOMER',
      resolution: 'Work not done.', resolvedById: customerId,
    })
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.availableBalanceCents).toBe(0)
  })
})

describe('splitting', () => {
  it('refunds the requested amount and pays the worker out of the rest', async () => {
    const job = await disputedJob()
    const half = Math.round(job.customerTotalCents / 2)
    const result = await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'SPLIT', refundCents: half,
      resolution: 'Front was done, back was not. Half each.',
      resolvedById: customerId,
    })

    expect(result.customerRefundCents).toBe(half)
    expect(result.workerPaidCents).toBeGreaterThan(0)
    expect(result.workerPaidCents).toBeLessThan(job.workerPayoutCents)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('pays the worker for the portion that stands, not half the gross', async () => {
    // A worker found at fault for half the job is paid for half of it, after
    // the platform's cut on that half — not half of what the customer paid.
    const job = await disputedJob()
    const half = Math.round(job.customerTotalCents / 2)
    const result = await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'SPLIT', refundCents: half,
      resolution: 'Half.', resolvedById: customerId,
    })
    expect(result.workerPaidCents).toBeLessThan(half)
  })

  it('refuses a split that is really a full decision', async () => {
    const job = await disputedJob()
    for (const refundCents of [0, job.customerTotalCents, job.customerTotalCents + 1]) {
      await expect(resolveDispute(deps, {
        disputeId: job.disputeId, decision: 'SPLIT', refundCents,
        resolution: 'x', resolvedById: customerId,
      })).rejects.toThrow()
    }
  })

  it('refuses a fractional refund', async () => {
    const job = await disputedJob()
    await expect(resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'SPLIT', refundCents: 1234.5,
      resolution: 'x', resolvedById: customerId,
    })).rejects.toThrow()
  })
})

describe('the money always adds up', () => {
  it('conserves the customer total on every decision, at every price', async () => {
    // The property that matters more than any individual path: whatever the
    // admin decides, the three outcomes sum to exactly what was paid.
    for (const priceCents of [2500, 6000, 9999, 10_000, 47_531]) {
      for (const decision of ['WORKER', 'CUSTOMER', 'SPLIT'] as const) {
        const job = await disputedJob(priceCents)
        const result = await resolveDispute(deps, {
          disputeId: job.disputeId,
          decision,
          ...(decision === 'SPLIT' ? { refundCents: Math.floor(job.customerTotalCents / 3) } : {}),
          resolution: 'Decided.', resolvedById: customerId,
        })

        const disbursed = result.customerRefundCents + result.workerPaidCents + result.platformRetainedCents
        expect(disbursed, `${decision} @ ${priceCents}`).toBe(job.customerTotalCents)
        expect((await ledgerIsBalanced(prisma)).balanced, `${decision} @ ${priceCents}`).toBe(true)

        await resetDatabaseForNextCase()
      }
    }
  }, 60_000)

  it('never leaves money in escrow', async () => {
    const job = await disputedJob()
    await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'SPLIT', refundCents: 3000,
      resolution: 'Half.', resolvedById: customerId,
    })
    expect(await accountBalance(prisma, ACCOUNTS.escrow)).toBe(0)
  })
})

describe('guard rails', () => {
  it('refuses to decide the same dispute twice', async () => {
    // The second decision would move the money a second time.
    const job = await disputedJob()
    await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'WORKER',
      resolution: 'Done.', resolvedById: customerId,
    })
    await expect(resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'CUSTOMER',
      resolution: 'Changed my mind.', resolvedById: customerId,
    })).rejects.toThrow(/already been decided/)
  })

  it('records the decision, the amount and who made it', async () => {
    const job = await disputedJob()
    await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'SPLIT', refundCents: 4000,
      resolution: 'Front done, back not.', resolvedById: customerId,
    })
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: job.disputeId } })
    expect(dispute.status).toBe('RESOLVED_SPLIT')
    expect(dispute.refundCents).toBe(4000)
    expect(dispute.resolution).toBe('Front done, back not.')
    expect(dispute.resolvedById).toBe(customerId)
    expect(dispute.resolvedAt).not.toBeNull()
  })

  it('writes an audit row, because a money decision needs a name on it', async () => {
    const job = await disputedJob()
    await resolveDispute(deps, {
      disputeId: job.disputeId, decision: 'WORKER',
      resolution: 'Photos are clear.', resolvedById: customerId,
    })
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'dispute.resolved', entityId: job.disputeId },
    })
    expect(audit).not.toBeNull()
    expect(audit!.actorId).toBe(customerId)
    expect(JSON.stringify(audit!.after)).toContain('Photos are clear')
  })

  it('404s an unknown dispute', async () => {
    await expect(resolveDispute(deps, {
      disputeId: 'nope', decision: 'WORKER', resolution: 'x', resolvedById: customerId,
    })).rejects.toThrow()
  })
})

/** Between cases in the loop above, so each starts from a clean ledger. */
async function resetDatabaseForNextCase() {
  await resetDatabase()
  provider.reset()
  const category = await createCategory()
  const customer = await createCustomer()
  const property = await createProperty(customer.id)
  const worker = await createWorker({ categoryId: category.id })
  categoryId = category.id
  customerId = customer.id
  propertyId = property.id
  workerUserId = worker.user.id
  workerProfileId = worker.profile.id
  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_test_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
  await prisma.workerProfile.update({
    where: { id: workerProfileId },
    data: { stripeAccountId: 'acct_test_1', payoutsEnabled: true, chargesEnabled: true },
  })
}
