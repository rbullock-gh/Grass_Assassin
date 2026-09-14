import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob,
} from '../../../test/factories.js'
import { buildServer } from '../../http/server.js'
import { FakePaymentProvider } from './fake-provider.js'
import { handleWebhook, WebhookSignatureError } from './webhooks.js'
import { captureForClaim } from './settlement.js'
import { attemptClaim, confirmClaimPaid } from '../jobs/claim.js'
import { ledgerIsBalanced, accountBalance, ACCOUNTS } from './ledger.js'

const provider = new FakePaymentProvider()
const SECRET = 'whsec_test'
const deps = { db: prisma, provider, webhookSecret: SECRET }

let app: FastifyInstance
let categoryId: string
let customerId: string
let propertyId: string
let workerUserId: string
let workerProfileId: string

beforeAll(async () => {
  await prisma.$connect()
  app = await buildServer({
    db: prisma, provider,
    config: {
      accessSecret: 'test-access-secret-at-least-32-characters-long',
      accessTtlSeconds: 900, refreshTtlDays: 30, ipSalt: 'salt',
      isProduction: false, rateLimits: { enabled: false }, webhookSecret: SECRET,
    },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

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
    data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
  await prisma.workerProfile.update({
    where: { id: workerProfileId },
    data: { stripeAccountId: 'acct_wh_1', payoutsEnabled: false, chargesEnabled: false },
  })
})

/** The fake provider treats this exact signature as valid. */
const VALID = 'valid-test-signature'

const send = (event: { id: string; type: string; data: unknown }, signature = VALID) =>
  handleWebhook(deps, { rawBody: JSON.stringify(event), signature })

describe('signature verification', () => {
  it('refuses an unsigned or wrongly signed delivery', async () => {
    const event = { id: 'evt_1', type: 'account.updated', data: { object: { id: 'acct_wh_1' } } }
    await expect(send(event, 'not-the-signature')).rejects.toThrow(WebhookSignatureError)
  })

  it('does not act on an unverified body', async () => {
    const event = {
      id: 'evt_2', type: 'account.updated',
      data: { object: { id: 'acct_wh_1', payouts_enabled: true, charges_enabled: true } },
    }
    await send(event, 'forged').catch(() => undefined)

    // An attacker-controlled body must not enable payouts.
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.payoutsEnabled).toBe(false)
  })

  it('leaks nothing about why verification failed', async () => {
    const event = { id: 'evt_3', type: 'account.updated', data: {} }
    const message = await send(event, 'wrong').catch((e: Error) => e.message)
    expect(message).toBe('Webhook signature verification failed')
  })
})

describe('idempotency', () => {
  it('processes a delivery once and reports a retry as duplicate', async () => {
    const event = {
      id: 'evt_dup', type: 'account.updated',
      data: { object: { id: 'acct_wh_1', payouts_enabled: true, charges_enabled: true } },
    }

    expect((await send(event)).status).toBe('processed')
    expect((await send(event)).status).toBe('duplicate')
    expect((await send(event)).status).toBe('duplicate')
  })

  it('does not double-apply a retried chargeback', async () => {
    // The case that matters: providers retry for days, and applying a
    // chargeback twice would take the money out of our books twice.
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })
    await captureForClaim(deps, { jobId: job.id, workerUserId })
    await confirmClaimPaid(prisma, job.id, workerUserId)

    const charge = await prisma.transaction.findFirstOrThrow({
      where: { jobId: job.id, kind: 'CHARGE' }, select: { stripeChargeId: true },
    })
    const event = {
      id: 'evt_dispute', type: 'charge.dispute.created',
      data: { object: { charge: charge.stripeChargeId, amount: 6480, reason: 'fraudulent' } },
    }

    await send(event)
    const afterFirst = await accountBalance(prisma, ACCOUNTS.platformRevenue)

    await send(event)
    await send(event)

    expect(await accountBalance(prisma, ACCOUNTS.platformRevenue)).toBe(afterFirst)
    expect(await prisma.transaction.count({ where: { jobId: job.id, kind: 'CHARGEBACK' } })).toBe(1)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('treats distinct events with the same type as separate', async () => {
    const make = (id: string) => ({
      id, type: 'account.updated',
      data: { object: { id: 'acct_wh_1', payouts_enabled: true, charges_enabled: true } },
    })
    expect((await send(make('evt_a'))).status).toBe('processed')
    expect((await send(make('evt_b'))).status).toBe('processed')
  })
})

describe('connected account updates', () => {
  it('enables payouts when the worker finishes onboarding', async () => {
    // This only ever reaches us by webhook — the worker completes Stripe's
    // hosted onboarding in a browser we never see. Without it they would stay
    // permanently unable to be paid.
    await send({
      id: 'evt_acct', type: 'account.updated',
      data: { object: { id: 'acct_wh_1', payouts_enabled: true, charges_enabled: true } },
    })

    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.payoutsEnabled).toBe(true)
    expect(profile.chargesEnabled).toBe(true)
  })

  it('disables payouts again if the account is restricted', async () => {
    await prisma.workerProfile.update({
      where: { id: workerProfileId }, data: { payoutsEnabled: true },
    })

    await send({
      id: 'evt_restricted', type: 'account.updated',
      data: { object: { id: 'acct_wh_1', payouts_enabled: false, charges_enabled: false } },
    })

    expect((await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })).payoutsEnabled).toBe(false)
  })

  it('ignores an account we do not know', async () => {
    const result = await send({
      id: 'evt_unknown', type: 'account.updated',
      data: { object: { id: 'acct_not_ours', payouts_enabled: true } },
    })
    expect(result.status).toBe('processed')
  })
})

describe('async payment failure', () => {
  it('returns the job to the pool when a charge fails after submission', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })
    await captureForClaim(deps, { jobId: job.id, workerUserId })
    // Deliberately NOT confirming — this models a payment that resolved
    // asynchronously, leaving the reservation open.

    const charge = await prisma.transaction.findFirstOrThrow({
      where: { jobId: job.id, kind: 'CHARGE' }, select: { stripePaymentIntentId: true },
    })

    await send({
      id: 'evt_failed', type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: charge.stripePaymentIntentId,
          last_payment_error: { code: 'authentication_required', message: 'Authentication required.' },
        },
      },
    })

    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
    expect(after.status).toBe('POSTED')
    expect(after.claimedByWorkerId).toBeNull()

    const transaction = await prisma.transaction.findFirstOrThrow({ where: { jobId: job.id, kind: 'CHARGE' } })
    expect(transaction.status).toBe('FAILED')
    expect(transaction.failureCode).toBe('authentication_required')
  })

  it('does not disturb a job that already moved on', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })
    await captureForClaim(deps, { jobId: job.id, workerUserId })
    await confirmClaimPaid(prisma, job.id, workerUserId)

    const charge = await prisma.transaction.findFirstOrThrow({
      where: { jobId: job.id, kind: 'CHARGE' }, select: { stripePaymentIntentId: true },
    })

    await send({
      id: 'evt_late', type: 'payment_intent.payment_failed',
      data: { object: { id: charge.stripePaymentIntentId } },
    })

    // A late failure event must not snatch a claimed job away from a worker
    // who may already be driving to it.
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CLAIMED')
  })
})

describe('disputes', () => {
  it('flags a chargeback for human review rather than acting automatically', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })
    await captureForClaim(deps, { jobId: job.id, workerUserId })
    await confirmClaimPaid(prisma, job.id, workerUserId)

    const charge = await prisma.transaction.findFirstOrThrow({
      where: { jobId: job.id, kind: 'CHARGE' }, select: { stripeChargeId: true },
    })

    await send({
      id: 'evt_cb', type: 'charge.dispute.created',
      data: { object: { charge: charge.stripeChargeId, amount: 6480, reason: 'product_not_received' } },
    })

    const flag = await prisma.fraudFlag.findFirstOrThrow({ where: { jobId: job.id } })
    expect(flag.signal).toBe('CHARGEBACK_OPENED')
    expect(flag.severity).toBe(5)
    expect(flag.dismissed).toBe(false)
    // Nothing irreversible happened to the worker.
    expect((await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })).status).toBe('APPROVED')
  })

  it('keeps the ledger balanced when money is withdrawn', async () => {
    const job = await createJob({ customerId, propertyId, categoryId, priceCents: 6000 })
    await attemptClaim(prisma, { jobId: job.id, workerUserId })
    await captureForClaim(deps, { jobId: job.id, workerUserId })
    await confirmClaimPaid(prisma, job.id, workerUserId)

    const charge = await prisma.transaction.findFirstOrThrow({
      where: { jobId: job.id, kind: 'CHARGE' }, select: { stripeChargeId: true },
    })
    await send({
      id: 'evt_cb2', type: 'charge.dispute.created',
      data: { object: { charge: charge.stripeChargeId, amount: 6480, reason: 'fraudulent' } },
    })

    const { balanced, delta } = await ledgerIsBalanced(prisma)
    expect(balanced, `ledger off by ${delta}`).toBe(true)
  })
})

describe('payouts', () => {
  it('returns a failed payout to the worker\'s available balance', async () => {
    await prisma.workerProfile.update({
      where: { id: workerProfileId }, data: { availableBalanceCents: 0 },
    })
    await prisma.payout.create({
      data: {
        id: 'po_local', workerProfileId, amountCents: 5280,
        status: 'IN_TRANSIT', stripePayoutId: 'po_stripe_1',
      },
    })

    await send({
      id: 'evt_po_fail', type: 'payout.failed',
      data: { object: { id: 'po_stripe_1', failure_message: 'Account closed' } },
    })

    // The money never left, so it must reappear rather than silently vanishing
    // from the worker's app.
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    expect(profile.availableBalanceCents).toBe(5280)
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: 'po_local' } })).status).toBe('FAILED')
  })

  it('does not re-credit a payout failure that is retried', async () => {
    await prisma.payout.create({
      data: {
        id: 'po_local2', workerProfileId, amountCents: 5280,
        status: 'IN_TRANSIT', stripePayoutId: 'po_stripe_2',
      },
    })
    const event = {
      id: 'evt_po_fail2', type: 'payout.failed',
      data: { object: { id: 'po_stripe_2', failure_message: 'Account closed' } },
    }

    await send(event)
    const after = await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })
    await send(event)
    await send(event)

    expect((await prisma.workerProfile.findUniqueOrThrow({ where: { id: workerProfileId } })).availableBalanceCents)
      .toBe(after.availableBalanceCents)
  })

  it('marks a successful payout as paid', async () => {
    await prisma.payout.create({
      data: {
        id: 'po_local3', workerProfileId, amountCents: 5280,
        status: 'IN_TRANSIT', stripePayoutId: 'po_stripe_3',
      },
    })

    await send({
      id: 'evt_po_paid', type: 'payout.paid',
      data: { object: { id: 'po_stripe_3', arrival_date: 1781000000 } },
    })

    const payout = await prisma.payout.findUniqueOrThrow({ where: { id: 'po_local3' } })
    expect(payout.status).toBe('PAID')
    expect(payout.arrivalDate).not.toBeNull()
  })
})

describe('unknown events', () => {
  it('acknowledges rather than rejecting, so the provider stops retrying', async () => {
    const result = await send({ id: 'evt_weird', type: 'invoice.upcoming', data: { object: {} } })
    expect(result.status).toBe('ignored')
  })
})

describe('the HTTP endpoint', () => {
  it('rejects a delivery with no signature header', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_x', type: 'account.updated', data: {} }),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('MISSING_SIGNATURE')
  })

  it('rejects a bad signature with 400, not 500', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'forged' },
      payload: JSON.stringify({ id: 'evt_y', type: 'account.updated', data: {} }),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('INVALID_SIGNATURE')
  })

  it('accepts a valid delivery and returns 200', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': VALID },
      payload: JSON.stringify({
        id: 'evt_http', type: 'account.updated',
        data: { object: { id: 'acct_wh_1', payouts_enabled: true, charges_enabled: true } },
      }),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('processed')
  })

  it('returns 200 for a duplicate so the provider stops retrying', async () => {
    const payload = JSON.stringify({
      id: 'evt_http_dup', type: 'account.updated',
      data: { object: { id: 'acct_wh_1', payouts_enabled: true } },
    })
    const headers = { 'content-type': 'application/json', 'stripe-signature': VALID }

    await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', headers, payload })
    const second = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', headers, payload })

    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe('duplicate')
  })

  it('needs no authentication, since the signature IS the authentication', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': VALID },
      payload: JSON.stringify({ id: 'evt_noauth', type: 'invoice.upcoming', data: { object: {} } }),
    })
    expect(response.statusCode).toBe(200)
  })
})
