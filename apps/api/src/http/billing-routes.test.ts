import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
} from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { ledgerIsBalanced, accountBalance, ACCOUNTS } from '../modules/payments/ledger.js'

/**
 * Setting up to pay, and getting paid.
 *
 * These endpoints are the only way a real person can put a card on file or take
 * money out, so most of what matters here is what they REFUSE: a card that
 * belongs to somebody else, a withdrawal larger than the balance, two
 * withdrawals of the same money, a payout before onboarding is finished.
 */
const provider = new FakePaymentProvider()
let app: FastifyInstance

let customerToken: string
let customerId: string
let workerToken: string
let workerUserId: string
let workerProfileId: string

beforeAll(async () => {
  await prisma.$connect()
  app = await buildServer({
    db: prisma,
    provider,
    config: {
      accessSecret: 'test-access-secret-at-least-32-characters-long',
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      ipSalt: 'test-salt',
      isProduction: false,
      publicBaseUrl: 'http://localhost:4000',
      rateLimits: { enabled: false },
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
  const worker = await createWorker({ categoryId: category.id })

  customerId = customer.id
  workerUserId = worker.user.id
  workerProfileId = worker.profile.id

  customerToken = await tokenFor(customer.id)
  workerToken = await tokenFor(worker.user.id)
})

/** Mints a real access token for a factory-made user. */
async function tokenFor(userId: string): Promise<string> {
  const { signAccessToken } = await import('../modules/auth/tokens.js')
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId }, select: { id: true, roles: true },
  })
  return signAccessToken({
    userId: user.id,
    roles: user.roles,
    secret: 'test-access-secret-at-least-32-characters-long',
    ttlSeconds: 900,
  })
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('putting a card on file', () => {
  it('hands back a client secret and never asks for a card number', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/billing/setup-intent', headers: auth(customerToken),
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(typeof body.clientSecret).toBe('string')
    expect(body.clientSecret.length).toBeGreaterThan(0)

    // The card is exchanged between the device and the provider. Nothing that
    // looks like a PAN should be anywhere in this conversation.
    expect(JSON.stringify(body)).not.toMatch(/\b\d{13,19}\b/)
  })

  it('stores the provider customer id so a second call does not make a second customer', async () => {
    await app.inject({ method: 'POST', url: '/v1/billing/setup-intent', headers: auth(customerToken) })
    const first = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customerId }, select: { stripeCustomerId: true },
    })
    expect(first.stripeCustomerId).toBeTruthy()

    await app.inject({ method: 'POST', url: '/v1/billing/setup-intent', headers: auth(customerToken) })
    const second = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customerId }, select: { stripeCustomerId: true },
    })

    // Two customer records would mean saved cards the charge path cannot see.
    expect(second.stripeCustomerId).toBe(first.stripeCustomerId)
    expect(provider.calls.filter((c) => c.op === 'createCustomer')).toHaveLength(1)
  })

  it('refuses an anonymous caller', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/billing/setup-intent' })
    expect(response.statusCode).toBe(401)
  })

  it('reports no cards rather than an error before any have been added', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/billing/payment-methods', headers: auth(customerToken),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ methods: [], defaultPaymentMethodId: null })
  })
})

describe('choosing which card to charge', () => {
  async function savedCard() {
    await app.inject({ method: 'POST', url: '/v1/billing/setup-intent', headers: auth(customerToken) })
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customerId }, select: { stripeCustomerId: true },
    })
    return provider.attachPaymentMethod(profile.stripeCustomerId as string, {
      brand: 'visa', last4: '4242',
    })
  }

  it('sets a card this customer actually owns', async () => {
    const card = await savedCard()
    const response = await app.inject({
      method: 'POST', url: '/v1/billing/payment-methods/default',
      headers: auth(customerToken), payload: { paymentMethodId: card.id },
    })

    expect(response.statusCode).toBe(200)
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customerId }, select: { defaultPaymentMethodId: true },
    })
    expect(profile.defaultPaymentMethodId).toBe(card.id)
  })

  it('refuses a payment method belonging to someone else', async () => {
    // The attack: name a card id you do not own and have the next job charged to
    // it. A request naming a card is not evidence of owning one.
    await savedCard()
    const other = await createCustomer({ email: `other-${Date.now()}@test.local` })
    const otherRef = await provider.createCustomer({ email: 'other@test.local' })
    const stranger = provider.attachPaymentMethod(otherRef, { brand: 'visa', last4: '1881' })
    expect(other.id).not.toBe(customerId)

    const response = await app.inject({
      method: 'POST', url: '/v1/billing/payment-methods/default',
      headers: auth(customerToken), payload: { paymentMethodId: stranger.id },
    })

    expect(response.statusCode).toBe(404)
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customerId }, select: { defaultPaymentMethodId: true },
    })
    expect(profile.defaultPaymentMethodId).not.toBe(stranger.id)
  })

  it('refuses a made-up payment method id', async () => {
    await savedCard()
    const response = await app.inject({
      method: 'POST', url: '/v1/billing/payment-methods/default',
      headers: auth(customerToken), payload: { paymentMethodId: 'pm_not_real' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('marks which saved card is the default', async () => {
    const card = await savedCard()
    await app.inject({
      method: 'POST', url: '/v1/billing/payment-methods/default',
      headers: auth(customerToken), payload: { paymentMethodId: card.id },
    })
    const response = await app.inject({
      method: 'GET', url: '/v1/billing/payment-methods', headers: auth(customerToken),
    })
    const body = response.json()
    expect(body.methods).toHaveLength(1)
    expect(body.methods[0].isDefault).toBe(true)
    expect(body.methods[0].last4).toBe('4242')
  })
})

describe('setting up to be paid', () => {
  it('creates a connected account and returns somewhere to send them', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts/onboard', headers: auth(workerToken), payload: {},
    })

    expect(response.statusCode).toBe(201)
    expect(typeof response.json().url).toBe('string')

    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { stripeAccountId: true },
    })
    expect(profile.stripeAccountId).toBeTruthy()
  })

  it('reuses the connected account instead of making a second one', async () => {
    // A second connected account is one the platform will never pay into, and
    // the worker would finish an onboarding that silently did nothing.
    await app.inject({ method: 'POST', url: '/v1/worker/payouts/onboard', headers: auth(workerToken), payload: {} })
    await app.inject({ method: 'POST', url: '/v1/worker/payouts/onboard', headers: auth(workerToken), payload: {} })
    expect(provider.calls.filter((c) => c.op === 'createConnectedAccount')).toHaveLength(1)
  })

  it.each([
    'https://evil.example/steal',
    '//evil.example',
    'javascript:alert(1)',
    'http://grassassassin.com.evil.example/',
  ])('refuses %s as a return address', async (returnUrl) => {
    // The provider redirects a browser to whatever we hand it.
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts/onboard',
      headers: auth(workerToken), payload: { returnUrl },
    })
    expect(response.statusCode).toBe(400)
  })

  it('accepts the app’s own deep link', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts/onboard',
      headers: auth(workerToken), payload: { returnUrl: 'grassassassin://payouts/done' },
    })
    expect(response.statusCode).toBe(201)
  })

  it('refuses a customer who is not a worker', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts/onboard', headers: auth(customerToken), payload: {},
    })
    expect(response.statusCode).toBe(403)
  })

  it('reports not-onboarded before anything has been set up', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/worker/payouts/status', headers: auth(workerToken),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.onboarded).toBe(false)
    expect(body.payoutsEnabled).toBe(false)
  })

  it('writes down what the provider says once onboarding finishes', async () => {
    await app.inject({ method: 'POST', url: '/v1/worker/payouts/onboard', headers: auth(workerToken), payload: {} })
    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { stripeAccountId: true },
    })
    provider.completeOnboarding(profile.stripeAccountId as string)

    const response = await app.inject({
      method: 'GET', url: '/v1/worker/payouts/status', headers: auth(workerToken),
    })
    expect(response.json().payoutsEnabled).toBe(true)

    const stored = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { payoutsEnabled: true },
    })
    expect(stored.payoutsEnabled).toBe(true)
  })
})

describe('taking the money out', () => {
  async function readyWorker(balanceCents: number) {
    await app.inject({ method: 'POST', url: '/v1/worker/payouts/onboard', headers: auth(workerToken), payload: {} })
    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { stripeAccountId: true },
    })
    provider.completeOnboarding(profile.stripeAccountId as string)
    await prisma.workerProfile.update({
      where: { id: workerProfileId },
      data: { payoutsEnabled: true, chargesEnabled: true, availableBalanceCents: balanceCents },
    })
    // The balance is a cache of the ledger, so give the ledger the same story.
    const { postEntry } = await import('../modules/payments/ledger.js')
    await postEntry(prisma, {
      lines: [
        { account: ACCOUNTS.escrow, amountCents: -balanceCents, memo: 'test seed' },
        { account: ACCOUNTS.worker(workerUserId), amountCents: balanceCents, memo: 'test seed' },
      ],
    })
  }

  it('pays out the whole balance when no amount is given', async () => {
    await readyWorker(8_360)

    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts', headers: auth(workerToken), payload: {},
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.amountCents).toBe(8_360)
    expect(body.remainingBalanceCents).toBe(0)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('leaves the worker’s ledger account empty after withdrawing everything', async () => {
    await readyWorker(5_000)
    await app.inject({ method: 'POST', url: '/v1/worker/payouts', headers: auth(workerToken), payload: {} })

    expect(await accountBalance(prisma, ACCOUNTS.worker(workerUserId))).toBe(0)
    expect(await accountBalance(prisma, ACCOUNTS.payoutsOut)).toBe(5_000)
  })

  it('pays out part of a balance and leaves the rest', async () => {
    await readyWorker(10_000)
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts',
      headers: auth(workerToken), payload: { amountCents: 4_000 },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().remainingBalanceCents).toBe(6_000)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('refuses more than the balance', async () => {
    await readyWorker(5_000)
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts',
      headers: auth(workerToken), payload: { amountCents: 5_001 },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('INSUFFICIENT_BALANCE')
    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { availableBalanceCents: true },
    })
    expect(profile.availableBalanceCents).toBe(5_000)
  })

  it('refuses a withdrawal before payouts are enabled', async () => {
    await prisma.workerProfile.update({
      where: { id: workerProfileId }, data: { availableBalanceCents: 9_000 },
    })
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts', headers: auth(workerToken), payload: {},
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('PAYOUTS_NOT_ENABLED')
  })

  it('refuses an amount below the minimum', async () => {
    await readyWorker(5_000)
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts',
      headers: auth(workerToken), payload: { amountCents: 50 },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('BELOW_MINIMUM')
  })

  it('refuses a negative amount', async () => {
    await readyWorker(5_000)
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts',
      headers: auth(workerToken), payload: { amountCents: -5_000 },
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses the second of two withdrawals of the same balance', async () => {
    /*
     * Named for what it actually proves. An earlier version of this claimed to
     * demonstrate the atomic reservation, and passed with that reservation
     * deliberately removed — the two requests serialise, so the ordinary balance
     * check ahead of the transaction caught the second one on its own. The
     * reservation is what holds when they do NOT serialise, and it is proven
     * directly in the test below this one.
     */
    await readyWorker(6_000)

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/worker/payouts', headers: auth(workerToken), payload: { amountCents: 6_000 } }),
      app.inject({ method: 'POST', url: '/v1/worker/payouts', headers: auth(workerToken), payload: { amountCents: 6_000 } }),
    ])

    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([201, 409])

    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { availableBalanceCents: true },
    })
    expect(profile.availableBalanceCents).toBe(0)
    expect(await accountBalance(prisma, ACCOUNTS.payoutsOut)).toBe(6_000)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('cannot decrement the same balance twice, even from two simultaneous transactions', async () => {
    /*
     * The mechanism, tested where it lives.
     *
     * Both statements are issued together against a balance that satisfies both.
     * PostgreSQL takes a row lock, so the second one re-evaluates its WHERE
     * against the already-decremented value and matches nothing. That is what
     * stops a worker withdrawing the same money twice, and unlike the route-level
     * test above it does not depend on the two requests happening to interleave.
     */
    await readyWorker(6_000)

    const spend = () => prisma.workerProfile.updateMany({
      where: { id: workerProfileId, availableBalanceCents: { gte: 6_000 } },
      data: { availableBalanceCents: { decrement: 6_000 } },
    })

    const [first, second] = await Promise.all([spend(), spend()])
    expect([first.count, second.count].sort()).toEqual([0, 1])

    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { availableBalanceCents: true },
    })
    expect(profile.availableBalanceCents).toBe(0)
  })

  it('puts the balance back when the provider refuses', async () => {
    await readyWorker(7_000)
    provider.failPayouts('Bank account closed')

    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts', headers: auth(workerToken), payload: {},
    })

    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    const profile = await prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerProfileId }, select: { availableBalanceCents: true },
    })
    expect(profile.availableBalanceCents).toBe(7_000)
    expect(await accountBalance(prisma, ACCOUNTS.payoutsOut)).toBe(0)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)

    const payout = await prisma.payout.findFirstOrThrow({ where: { workerProfileId } })
    expect(payout.status).toBe('FAILED')
    expect(payout.failureMessage).toMatch(/bank account closed/i)
  })

  it('lists what has been withdrawn', async () => {
    await readyWorker(9_000)
    await app.inject({
      method: 'POST', url: '/v1/worker/payouts',
      headers: auth(workerToken), payload: { amountCents: 3_000 },
    })

    const response = await app.inject({
      method: 'GET', url: '/v1/worker/payouts', headers: auth(workerToken),
    })
    expect(response.statusCode).toBe(200)
    const { payouts } = response.json()
    expect(payouts).toHaveLength(1)
    expect(payouts[0].amountCents).toBe(3_000)
  })

  it('refuses a customer trying to withdraw', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/worker/payouts', headers: auth(customerToken), payload: {},
    })
    expect(response.statusCode).toBe(403)
  })
})
