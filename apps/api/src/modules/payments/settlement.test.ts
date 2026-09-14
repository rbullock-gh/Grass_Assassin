import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob,
} from '../../../test/factories.js'
import { FakePaymentProvider } from './fake-provider.js'
import { captureForClaim, releaseToWorker, settleCancellation, chargeTip } from './settlement.js'
import { ledgerIsBalanced, accountBalance, ACCOUNTS, postEntry, UnbalancedLedgerError, trialBalance } from './ledger.js'
import { resolvePolicy, setConfig, CONFIG_KEYS } from './fee-config.js'
import { attemptClaim, confirmClaimPaid, releaseReservation } from '../jobs/claim.js'
import { quoteJob, DEFAULT_FEE_CONFIG } from '@grassassassin/shared'

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

  // Both sides fully set up for payments.
  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_test_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
  await prisma.workerProfile.update({
    where: { id: workerProfileId },
    data: { stripeAccountId: 'acct_test_1', payoutsEnabled: true, chargesEnabled: true },
  })
})

/** Drives a job from POSTED to CLAIMED with a successful capture. */
async function claimAndPay(jobId: string) {
  const claim = await attemptClaim(prisma, { jobId, workerUserId })
  expect(claim.outcome).toBe('WON')
  const capture = await captureForClaim(deps, { jobId, workerUserId })
  expect(capture.ok).toBe(true)
  await confirmClaimPaid(prisma, jobId, workerUserId)
  return capture
}

describe('ledger primitives', () => {
  it('refuses to write an entry that does not balance', async () => {
    await expect(postEntry(prisma, {
      lines: [
        { account: ACCOUNTS.escrow, amountCents: 5000 },
        { account: ACCOUNTS.platformRevenue, amountCents: 300 },
      ],
    })).rejects.toThrow(UnbalancedLedgerError)

    // Nothing partial was written — a lopsided write is worse than no write.
    expect(await prisma.ledgerEntry.count()).toBe(0)
  })

  it('writes a balanced entry', async () => {
    await postEntry(prisma, {
      lines: [
        { account: ACCOUNTS.customer('u1'), amountCents: -6480 },
        { account: ACCOUNTS.escrow, amountCents: 6000 },
        { account: ACCOUNTS.platformRevenue, amountCents: 480 },
      ],
    })
    expect(await prisma.ledgerEntry.count()).toBe(3)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('rejects non-integer amounts', async () => {
    await expect(postEntry(prisma, {
      lines: [
        { account: 'a', amountCents: 10.5 },
        { account: 'b', amountCents: -10.5 },
      ],
    })).rejects.toThrow(TypeError)
  })
})

describe('capture at claim', () => {
  it('charges the customer total and splits it into escrow and revenue', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    const quote = quoteJob(6000)

    await claimAndPay(job.id)

    const charge = provider.calls.find((c) => c.op === 'charge')
    expect(charge?.amountCents).toBe(quote.customerTotalCents) // $64.80

    expect(await accountBalance(prisma, ACCOUNTS.customer(customerId))).toBe(-quote.customerTotalCents)
    expect(await accountBalance(prisma, ACCOUNTS.escrow)).toBe(quote.jobPriceCents)
    // Only the service fee is revenue at this point — commission is not earned
    // until the work is approved and might still be refunded.
    expect(await accountBalance(prisma, ACCOUNTS.platformRevenue)).toBe(quote.serviceFeeCents)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('records a SUCCEEDED transaction with provider references', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)

    const tx = await prisma.transaction.findFirstOrThrow({ where: { jobId: job.id, kind: 'CHARGE' } })
    expect(tx.status).toBe('SUCCEEDED')
    expect(tx.stripePaymentIntentId).toMatch(/^pi_/)
    expect(tx.stripeChargeId).toMatch(/^ch_/)
  })

  it('does not charge twice when the capture is retried', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })

    const first = await captureForClaim(deps, { jobId: job.id, workerUserId })
    const second = await captureForClaim(deps, { jobId: job.id, workerUserId })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.transactionId).toBe(first.transactionId)
    // One ledger entry set, not two. A retried request must never double-charge.
    expect(await prisma.ledgerEntry.count({ where: { jobId: job.id } })).toBe(3)
    expect(await accountBalance(prisma, ACCOUNTS.customer(customerId))).toBe(-quoteJob(6000).customerTotalCents)
  })

  it('reports a declined card without moving any money', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })

    provider.failures.nextChargeFailure = { code: 'card_declined', message: 'Your card was declined.' }
    const result = await captureForClaim(deps, { jobId: job.id, workerUserId })

    expect(result.ok).toBe(false)
    expect(result.failureCode).toBe('card_declined')
    expect(await prisma.ledgerEntry.count()).toBe(0)

    const tx = await prisma.transaction.findFirstOrThrow({ where: { jobId: job.id } })
    expect(tx.status).toBe('FAILED')
  })

  it('returns the job to the pool after a declined card, so another worker can claim', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })

    provider.failures.nextChargeFailure = { code: 'card_declined', message: 'Declined.' }
    const capture = await captureForClaim(deps, { jobId: job.id, workerUserId })
    expect(capture.ok).toBe(false)

    await releaseReservation(prisma, job.id, workerUserId, 'card_declined')

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('POSTED')
    expect(after.claimedByWorkerId).toBeNull()

    // A different worker can now claim and pay successfully.
    const other = await createWorker({ categoryId })
    const retry = await attemptClaim(prisma, { jobId: job.id, workerUserId: other.user.id })
    expect(retry.outcome).toBe('WON')
  })

  it('fails cleanly when the customer has no saved payment method', async () => {
    await prisma.customerProfile.update({
      where: { userId: customerId },
      data: { stripeCustomerId: null, defaultPaymentMethodId: null },
    })
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })

    const result = await captureForClaim(deps, { jobId: job.id, workerUserId })
    expect(result.ok).toBe(false)
    expect(result.failureCode).toBe('no_payment_method')
    expect(provider.callsTo('charge')).toBe(0)
  })

  it('refuses to capture for a job that is not awaiting payment', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await expect(captureForClaim(deps, { jobId: job.id, workerUserId })).rejects.toThrow(/not awaiting payment/i)
  })
})

describe('release on approval', () => {
  it('transfers the worker payout and recognises commission as revenue', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    const quote = quoteJob(6000)
    await claimAndPay(job.id)

    const result = await releaseToWorker(deps, { jobId: job.id })
    expect(result.ok).toBe(true)

    const transfer = provider.calls.find((c) => c.op === 'transfer')
    expect(transfer?.amountCents).toBe(quote.workerPayoutCents) // $52.80

    expect(await accountBalance(prisma, ACCOUNTS.escrow)).toBe(0)
    expect(await accountBalance(prisma, ACCOUNTS.worker(workerUserId))).toBe(quote.workerPayoutCents)
    expect(await accountBalance(prisma, ACCOUNTS.platformRevenue))
      .toBe(quote.serviceFeeCents + quote.workerCommissionCents) // $4.80 + $7.20 = $12.00
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('credits the worker\'s available balance', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    await claimAndPay(job.id)
    await releaseToWorker(deps, { jobId: job.id })

    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.availableBalanceCents).toBe(quoteJob(6000).workerPayoutCents)
    expect(profile.lifetimeEarningsCents).toBe(quoteJob(6000).workerPayoutCents)
  })

  it('is idempotent against a replayed approval webhook', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    await claimAndPay(job.id)

    await releaseToWorker(deps, { jobId: job.id })
    await releaseToWorker(deps, { jobId: job.id })

    // Exactly one payout's worth, not two.
    expect(await accountBalance(prisma, ACCOUNTS.worker(workerUserId))).toBe(quoteJob(6000).workerPayoutCents)
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.availableBalanceCents).toBe(quoteJob(6000).workerPayoutCents)
  })

  it('reports a failed transfer without crediting the worker', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)

    provider.failures.transferFor = new Set(['acct_test_1'])
    const result = await releaseToWorker(deps, { jobId: job.id })

    expect(result.ok).toBe(false)
    expect(await accountBalance(prisma, ACCOUNTS.worker(workerUserId))).toBe(0)
    // Money stays in escrow rather than vanishing.
    expect(await accountBalance(prisma, ACCOUNTS.escrow)).toBe(quoteJob(6000).jobPriceCents)
  })

  it('refuses when the worker has not completed payout setup', async () => {
    await prisma.workerProfile.update({ where: { id: workerProfileId }, data: { stripeAccountId: null } })
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)

    await expect(releaseToWorker(deps, { jobId: job.id })).rejects.toThrow(/payout setup/i)
  })

  it('keeps the books balanced across the whole happy path', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 8500 })
    await claimAndPay(job.id)
    await releaseToWorker(deps, { jobId: job.id })

    const { balanced, delta } = await ledgerIsBalanced(prisma)
    expect(balanced, `ledger off by ${delta} cents`).toBe(true)

    const quote = quoteJob(8500)
    const balances = Object.fromEntries((await trialBalance(prisma)).map((r) => [r.account, r.balanceCents]))
    expect(balances[ACCOUNTS.customer(customerId)]).toBe(-quote.customerTotalCents)
    expect(balances[ACCOUNTS.worker(workerUserId)]).toBe(quote.workerPayoutCents)
    expect(balances[ACCOUNTS.platformRevenue]).toBe(quote.platformGrossCents)
  })
})

describe('cancellation settlement', () => {
  it('refunds in full before any claim, moving no money', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })

    const outcome = await settleCancellation(deps, { jobId: job.id, actor: 'CUSTOMER' })

    expect(outcome.customerRefundCents).toBe(quoteJob(6000).customerTotalCents)
    expect(provider.callsTo('refund')).toBe(0)
    expect(await prisma.ledgerEntry.count()).toBe(0)
  })

  it('refunds in full inside the grace period after a claim', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)

    const outcome = await settleCancellation(deps, { jobId: job.id, actor: 'CUSTOMER' })

    expect(outcome.customerRefundCents).toBe(quoteJob(6000).customerTotalCents)
    expect(outcome.workerCompensationCents).toBe(0)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
    expect(await accountBalance(prisma, ACCOUNTS.customer(customerId))).toBe(0)
  })

  it('compensates the worker when the customer cancels late', async () => {
    const job = await createJob({
      customerId, propertyId, categoryId,
      dueAt: new Date(Date.now() + 2 * 3_600_000), // 2h away — inside the late window
    })
    await claimAndPay(job.id)
    // Push the claim outside the grace period.
    await prisma.job.update({
      where: { id: job.id },
      data: { claimedAt: new Date(Date.now() - 3 * 3_600_000) },
    })

    const outcome = await settleCancellation(deps, { jobId: job.id, actor: 'CUSTOMER' })

    expect(outcome.workerCompensationCents).toBeGreaterThan(0)
    expect(outcome.customerRefundCents).toBeLessThan(quoteJob(6000).customerTotalCents)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)

    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.availableBalanceCents).toBe(outcome.workerCompensationCents)
  })

  it('pays the worker in full when the customer cancels after they are en route', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await prisma.job.update({ where: { id: job.id }, data: { status: 'EN_ROUTE', enRouteAt: new Date() } })

    const outcome = await settleCancellation(deps, { jobId: job.id, actor: 'CUSTOMER' })

    expect(outcome.workerCompensationCents).toBe(quoteJob(6000).workerPayoutCents)
    expect(outcome.customerRefundCents).toBe(quoteJob(6000).serviceFeeCents)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('refunds the customer fully when the WORKER cancels, at no cost to the customer', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await prisma.job.update({ where: { id: job.id }, data: { status: 'EN_ROUTE' } })

    const outcome = await settleCancellation(deps, { jobId: job.id, actor: 'WORKER' })

    expect(outcome.customerRefundCents).toBe(quoteJob(6000).customerTotalCents)
    expect(outcome.workerCompensationCents).toBe(0)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('conserves money on every cancellation path', async () => {
    const scenarios = [
      { status: 'CLAIMED' as const, actor: 'CUSTOMER' as const, claimedAgo: 0 },
      { status: 'CLAIMED' as const, actor: 'CUSTOMER' as const, claimedAgo: 5 * 3_600_000 },
      { status: 'EN_ROUTE' as const, actor: 'CUSTOMER' as const, claimedAgo: 5 * 3_600_000 },
      { status: 'IN_PROGRESS' as const, actor: 'CUSTOMER' as const, claimedAgo: 5 * 3_600_000 },
      { status: 'CLAIMED' as const, actor: 'WORKER' as const, claimedAgo: 5 * 3_600_000 },
    ]

    for (const s of scenarios) {
      await resetDatabase()
      provider.reset()
      const category = await createCategory()
      const customer = await createCustomer()
      const property = await createProperty(customer.id)
      const worker = await createWorker({ categoryId: category.id })
      await prisma.customerProfile.update({
        where: { userId: customer.id },
        data: { stripeCustomerId: 'cus_x', defaultPaymentMethodId: 'pm_test_visa' },
      })
      await prisma.workerProfile.update({
        where: { id: worker.profile.id },
        data: { stripeAccountId: 'acct_x', payoutsEnabled: true },
      })

      const job = await createJob({
        customerId: customer.id, propertyId: property.id, categoryId: category.id,
      })
      await attemptClaim(prisma, { jobId: job.id, workerUserId: worker.user.id })
      await captureForClaim(deps, { jobId: job.id, workerUserId: worker.user.id })
      await confirmClaimPaid(prisma, job.id, worker.user.id)
      await prisma.job.update({
        where: { id: job.id },
        data: { status: s.status, claimedAt: new Date(Date.now() - s.claimedAgo) },
      })

      const outcome = await settleCancellation(deps, { jobId: job.id, actor: s.actor })
      const disbursed = outcome.customerRefundCents + outcome.workerCompensationCents + outcome.platformRetainedCents

      expect(disbursed, `${s.status}/${s.actor} disbursed ${disbursed}`).toBe(quoteJob(6000).customerTotalCents)

      const { balanced, delta } = await ledgerIsBalanced(prisma)
      expect(balanced, `${s.status}/${s.actor} left the ledger off by ${delta}`).toBe(true)
    }
  })

  it('refuses to cancel a job that is already complete', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await prisma.job.update({ where: { id: job.id }, data: { status: 'PENDING_APPROVAL' } })

    await expect(settleCancellation(deps, { jobId: job.id, actor: 'CUSTOMER' }))
      .rejects.toThrow(/cannot be cancelled/i)
  })
})

describe('tips', () => {
  it('passes 100% of a tip to the worker', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await releaseToWorker(deps, { jobId: job.id })

    const before = await accountBalance(prisma, ACCOUNTS.platformRevenue)
    const result = await chargeTip(deps, { jobId: job.id, fromUserId: customerId, amountCents: 1500 })

    expect(result.ok).toBe(true)
    // The platform takes nothing from tips. Stated policy, enforced here.
    expect(await accountBalance(prisma, ACCOUNTS.platformRevenue)).toBe(before)

    const transfers = provider.calls.filter((c) => c.op === 'transfer')
    expect(transfers[transfers.length - 1]?.amountCents).toBe(1500)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('credits the worker\'s balance by the full tip', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await releaseToWorker(deps, { jobId: job.id })
    const beforeProfile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })

    await chargeTip(deps, { jobId: job.id, fromUserId: customerId, amountCents: 2000 })

    const after = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(after.availableBalanceCents).toBe(beforeProfile.availableBalanceCents + 2000)
  })

  it('lets a customer tip more than once', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await releaseToWorker(deps, { jobId: job.id })

    await chargeTip(deps, { jobId: job.id, fromUserId: customerId, amountCents: 500 })
    await chargeTip(deps, { jobId: job.id, fromUserId: customerId, amountCents: 700 })

    expect(await prisma.tip.count({ where: { jobId: job.id } })).toBe(2)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('refuses a tip from anyone but the job\'s customer', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    const stranger = await createCustomer()

    await expect(chargeTip(deps, { jobId: job.id, fromUserId: stranger.id, amountCents: 500 }))
      .rejects.toThrow(/only the customer/i)
  })

  it('rejects a zero or negative tip', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await claimAndPay(job.id)
    await expect(chargeTip(deps, { jobId: job.id, fromUserId: customerId, amountCents: 0 })).rejects.toThrow()
    await expect(chargeTip(deps, { jobId: job.id, fromUserId: customerId, amountCents: -100 })).rejects.toThrow()
  })
})

describe('fee configuration', () => {
  it('falls back to compiled defaults when the config table is empty', async () => {
    const policy = await resolvePolicy(prisma, null)
    expect(policy.fees.workerCommissionBps).toBe(DEFAULT_FEE_CONFIG.workerCommissionBps)
    expect(policy.fees.customerServiceFeeBps).toBe(DEFAULT_FEE_CONFIG.customerServiceFeeBps)
    expect(policy.autoApprovalHours).toBe(24)
  })

  it('applies a global override', async () => {
    const admin = await createCustomer()
    await setConfig(prisma, { key: CONFIG_KEYS.workerCommissionBps, value: 1000, adminId: admin.id })

    const policy = await resolvePolicy(prisma, null)
    expect(policy.fees.workerCommissionBps).toBe(1000)
  })

  it('lets a market override the global rate', async () => {
    const admin = await createCustomer()
    await setConfig(prisma, { key: CONFIG_KEYS.workerCommissionBps, value: 1200, adminId: admin.id })
    await setConfig(prisma, { key: CONFIG_KEYS.workerCommissionBps, value: 900, scopeKey: 'nashville', adminId: admin.id })

    expect((await resolvePolicy(prisma, null)).fees.workerCommissionBps).toBe(1200)
    expect((await resolvePolicy(prisma, 'nashville')).fees.workerCommissionBps).toBe(900)
    // An unconfigured market still gets the global value.
    expect((await resolvePolicy(prisma, 'austin')).fees.workerCommissionBps).toBe(1200)
  })

  it('audits every config change with its previous value', async () => {
    const admin = await createCustomer()
    await setConfig(prisma, { key: CONFIG_KEYS.workerCommissionBps, value: 1200, adminId: admin.id })
    await setConfig(prisma, { key: CONFIG_KEYS.workerCommissionBps, value: 1500, adminId: admin.id })

    const logs = await prisma.auditLog.findMany({
      where: { action: 'config.update' }, orderBy: { createdAt: 'asc' },
    })
    expect(logs).toHaveLength(2)
    expect(JSON.stringify(logs[1]!.before)).toContain('1200')
    expect(JSON.stringify(logs[1]!.after)).toContain('1500')
  })

  it('survives a malformed config row rather than taking checkout down', async () => {
    const admin = await createCustomer()
    await setConfig(prisma, { key: CONFIG_KEYS.workerCommissionBps, value: 'not-a-number', adminId: admin.id })

    const policy = await resolvePolicy(prisma, null)
    expect(policy.fees.workerCommissionBps).toBe(DEFAULT_FEE_CONFIG.workerCommissionBps)
  })
})
