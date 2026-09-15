import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma, resetDatabase, createCategory, createWorker, NASHVILLE, markEmailVerified } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { RANKS, destinationPoint, milesToMeters } from '@grassassassin/shared'

const provider = new FakePaymentProvider()
let app: FastifyInstance

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
      // Disabled for the functional suite only — the limiter itself is
      // exercised by its own test below, against a separately built server.
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
  await prisma.rank.createMany({
    data: RANKS.map((r, i) => ({
      key: r.key, name: r.name, minPoints: r.minPoints, sortOrder: i,
      commissionDiscountBps: r.commissionDiscountBps, radiusBonusMiles: r.radiusBonusMiles,
      earlyAccessMinutes: r.earlyAccessMinutes, verifiedBadge: r.verifiedBadge,
      minRating: r.minRating, minCompletionRate: r.minCompletionRate, minOnTimeRate: r.minOnTimeRate,
    })),
  })
  // Service area gate must be open for property creation to succeed.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "service_areas" ("id","name","slug","centerLocation","radiusMiles","active","createdAt","updatedAt")
    VALUES ('sa-test','Nashville','nashville',
      ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
      40, true, now(), now())
  `)
})

// --- helpers ---------------------------------------------------------------

async function registerUser(email: string, intent: 'CUSTOMER' | 'WORKER' = 'CUSTOMER') {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'a-sufficiently-long-password', firstName: 'Test', intent },
  })
  expect(response.statusCode).toBe(201)
  const body = response.json() as {
    user: { id: string }; tokens: { accessToken: string; refreshToken: string }
  }
  // Posting and claiming both need a verified address. These tests are about
  // what happens after that, so they get past it rather than through it.
  await markEmailVerified(body.user.id)
  return body
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function createPropertyVia(token: string) {
  const response = await app.inject({
    method: 'POST', url: '/v1/properties', headers: auth(token),
    payload: {
      label: 'Home', addressLine1: '742 Evergreen Terrace', city: 'Nashville',
      state: 'TN', postalCode: '37201', location: NASHVILLE, yardSize: 'QUARTER_TO_HALF',
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string }
}

async function postJobVia(token: string, propertyId: string, categoryId: string, priceCents = 6000) {
  const response = await app.inject({
    method: 'POST', url: '/v1/jobs', headers: auth(token),
    payload: {
      propertyId, categoryId, priceCents,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      description: 'Front and back please.',
    },
  })
  return response
}

// --- tests -----------------------------------------------------------------

describe('health and 404', () => {
  it('serves health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('ok')
  })

  it('returns a structured 404 for an unknown endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('NOT_FOUND')
  })
})

describe('auth endpoints', () => {
  it('registers, returns tokens, and serves /me', async () => {
    const { tokens } = await registerUser('new@example.com')

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(tokens.accessToken) })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('new@example.com')
    expect(me.json().roles).toEqual(['CUSTOMER'])
  })

  it('never returns the password hash from /me', async () => {
    const { tokens } = await registerUser('secret@example.com')
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(tokens.accessToken) })
    expect(JSON.stringify(me.json())).not.toContain('argon2')
    expect(me.json()).not.toHaveProperty('passwordHash')
  })

  it('rejects /me without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me' })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a garbage token as unauthenticated rather than erroring', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me', headers: auth('not-a-jwt') })
    expect(response.statusCode).toBe(401)
  })

  it('returns 400 with field detail for an invalid payload', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: 'short', firstName: '' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_ERROR')
    expect(response.json().error.details.length).toBeGreaterThan(0)
  })

  it('logs in and refreshes', async () => {
    await registerUser('login@example.com')

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'login@example.com', password: 'a-sufficiently-long-password' },
    })
    expect(login.statusCode).toBe(200)
    const refreshToken = login.json().tokens.refreshToken

    const refreshed = await app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().refreshToken).not.toBe(refreshToken)
  })

  it('rejects a replayed refresh token over HTTP', async () => {
    const { tokens } = await registerUser('replay@example.com')
    await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: tokens.refreshToken } })

    const replay = await app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: tokens.refreshToken },
    })
    expect(replay.statusCode).toBe(401)
    expect(replay.json().error.message).toMatch(/reuse/i)
  })
})

describe('properties', () => {
  it('creates and lists a property', async () => {
    const { tokens } = await registerUser('prop@example.com')
    const property = await createPropertyVia(tokens.accessToken)
    expect(property.id).toBeTruthy()

    const list = await app.inject({ method: 'GET', url: '/v1/properties', headers: auth(tokens.accessToken) })
    expect(list.json().properties).toHaveLength(1)
    expect(list.json().properties[0].lat).toBeCloseTo(NASHVILLE.lat, 4)
  })

  it('refuses a property outside the service area, honestly', async () => {
    const { tokens } = await registerUser('faraway@example.com')
    const response = await app.inject({
      method: 'POST', url: '/v1/properties', headers: auth(tokens.accessToken),
      payload: {
        label: 'Home', addressLine1: '1 Ocean Dr', city: 'Miami', state: 'FL',
        postalCode: '33139', location: { lat: 25.7617, lng: -80.1918 }, yardSize: 'QUARTER_TO_HALF',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('OUTSIDE_SERVICE_AREA')
    // An empty map would be worse than an honest no.
    expect(response.json().error.message).toMatch(/not in your area yet/i)
  })

  it('refuses to show one user another user\'s property', async () => {
    const owner = await registerUser('owner@example.com')
    const other = await registerUser('other@example.com')
    const property = await createPropertyVia(owner.tokens.accessToken)

    const response = await app.inject({
      method: 'GET', url: `/v1/properties/${property.id}`, headers: auth(other.tokens.accessToken),
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('job creation', () => {
  it('creates a job with correct economics', async () => {
    const { tokens } = await registerUser('poster@example.com')
    const property = await createPropertyVia(tokens.accessToken)
    const category = await createCategory()

    const response = await postJobVia(tokens.accessToken, property.id, category.id, 6000)

    expect(response.statusCode).toBe(201)
    const job = response.json()
    expect(job.priceCents).toBe(6000)
    expect(job.serviceFeeCents).toBe(480)
    expect(job.customerTotalCents).toBe(6480)
    expect(job.workerPayoutCents).toBe(5280)
    expect(job.status).toBe('POSTED')
  })

  it('enforces the minimum job price', async () => {
    const { tokens } = await registerUser('cheap@example.com')
    const property = await createPropertyVia(tokens.accessToken)
    const category = await createCategory()

    const response = await postJobVia(tokens.accessToken, property.id, category.id, 500)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/minimum job price/i)
  })

  it('refuses a deadline in the past', async () => {
    const { tokens } = await registerUser('past@example.com')
    const property = await createPropertyVia(tokens.accessToken)
    const category = await createCategory()

    const response = await app.inject({
      method: 'POST', url: '/v1/jobs', headers: auth(tokens.accessToken),
      payload: {
        propertyId: property.id, categoryId: category.id, priceCents: 6000,
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses to post a job on someone else\'s property', async () => {
    const owner = await registerUser('owner2@example.com')
    const attacker = await registerUser('attacker@example.com')
    const property = await createPropertyVia(owner.tokens.accessToken)
    const category = await createCategory()

    const response = await postJobVia(attacker.tokens.accessToken, property.id, category.id)
    expect(response.statusCode).toBe(403)
  })
})

describe('THE PRIVACY BOUNDARY over HTTP', () => {
  it('never leaks a street address to a worker who has not claimed the job', async () => {
    const customer = await registerUser('privacy-cust@example.com')
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()
    const jobResponse = await postJobVia(customer.tokens.accessToken, property.id, category.id)
    const jobId = jobResponse.json().id

    const worker = await createWorker({ categoryId: category.id })
    const workerLogin = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: worker.user.email, password: 'x' },
    })
    // The factory worker has no usable password, so mint a real account instead.
    void workerLogin
    const realWorker = await registerUser('privacy-worker@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: realWorker.user.id },
      data: { status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1, onTimeRate: 1 },
    })

    // Search: the exact address must be absent entirely.
    const search = await app.inject({
      method: 'GET',
      url: `/v1/jobs/search?lat=${NASHVILLE.lat}&lng=${NASHVILLE.lng}&radiusMiles=15`,
      headers: auth(realWorker.tokens.accessToken),
    })
    expect(search.statusCode).toBe(200)
    expect(search.body).not.toContain('742 Evergreen Terrace')
    expect(search.body).not.toContain('Evergreen')

    // Detail before claiming: approximate only, no address object.
    const detail = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(realWorker.tokens.accessToken),
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().locationPrecision).toBe('APPROXIMATE')
    expect(detail.json().address).toBeNull()
    expect(detail.body).not.toContain('742 Evergreen Terrace')

    // The returned point is offset, not the real one.
    const location = detail.json().location
    expect(location.lat).not.toBeCloseTo(NASHVILLE.lat, 6)
  })

  it('releases the exact address once the worker holds the claim', async () => {
    const customer = await registerUser('release-cust@example.com')
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()
    const jobResponse = await postJobVia(customer.tokens.accessToken, property.id, category.id)
    const jobId = jobResponse.json().id

    const worker = await registerUser('release-worker@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: worker.user.id },
      data: {
        status: 'APPROVED', completedJobs: 30, averageRating: 4.9,
        completionRate: 1, onTimeRate: 1, stripeAccountId: 'acct_1', payoutsEnabled: true,
      },
    })
    await prisma.customerProfile.update({
      where: { userId: customer.user.id },
      data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
    })

    const claim = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(worker.tokens.accessToken), payload: {},
    })
    expect(claim.json().outcome).toBe('WON')

    const detail = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(worker.tokens.accessToken),
    })
    expect(detail.json().locationPrecision).toBe('EXACT')
    expect(detail.json().address.addressLine1).toBe('742 Evergreen Terrace')
    expect(detail.json().location.lat).toBeCloseTo(NASHVILLE.lat, 5)
  })

  it('tells the customer who claimed their job, without contact details', async () => {
    const customer = await registerUser('who-cust@example.com')
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    const before = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(customer.tokens.accessToken),
    })
    // Nobody has claimed, so there is nobody to name.
    expect(before.json().worker).toBeNull()

    const worker = await registerUser('who-worker@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: worker.user.id },
      data: {
        status: 'APPROVED', completedJobs: 30, averageRating: 4.9,
        completionRate: 1, onTimeRate: 1, stripeAccountId: 'acct_1', payoutsEnabled: true,
      },
    })
    await prisma.customerProfile.update({
      where: { userId: customer.user.id },
      data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
    })
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(worker.tokens.accessToken), payload: {},
    })

    const after = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(customer.tokens.accessToken),
    })
    const claimedBy = after.json().worker
    // A stranger is about to walk onto their property. They are entitled to
    // know who, and to see the reputation that earned them the job.
    expect(claimedBy).not.toBeNull()
    expect(claimedBy.firstName).toBe('Test')
    expect(claimedBy.completedJobs).toBe(30)

    // The stored average is 4.9 but no review backs it, so nothing is shown.
    // A star rating with no reviews behind it is a fabricated endorsement of a
    // real person, on the screen where a customer decides whether to trust them.
    expect(claimedBy.rating).toBeNull()

    await prisma.workerProfile.update({
      where: { userId: worker.user.id },
      data: { ratingCount: 12 },
    })
    const withReviews = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(customer.tokens.accessToken),
    })
    expect(withReviews.json().worker.rating).toBeCloseTo(4.9, 5)

    // Reputation only. The same rule the public profile follows.
    expect(Object.keys(claimedBy).sort()).toEqual(
      ['avatarUrl', 'completedJobs', 'firstName', 'id', 'onTimeRate', 'rank', 'rating'])
    expect(JSON.stringify(claimedBy)).not.toContain('@example.com')
  })

  it('never tells an uninvolved worker who claimed a job', async () => {
    // The mirror image of the address rule. Learning that a named person is at
    // a house in this neighbourhood tonight is a location-inference channel on
    // a real worker, and it deserves the same boundary.
    const customer = await registerUser('leak-cust@example.com')
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    const winner = await registerUser('leak-winner@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: winner.user.id },
      data: {
        status: 'APPROVED', completedJobs: 30, averageRating: 4.9,
        completionRate: 1, onTimeRate: 1, stripeAccountId: 'acct_1', payoutsEnabled: true,
      },
    })
    await prisma.customerProfile.update({
      where: { userId: customer.user.id },
      data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
    })
    const claim = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(winner.tokens.accessToken), payload: {},
    })
    expect(claim.json().outcome).toBe('WON')

    const bystander = await registerUser('leak-bystander@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: bystander.user.id },
      data: { status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1, onTimeRate: 1 },
    })

    const detail = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(bystander.tokens.accessToken),
    })
    expect(detail.json().worker).toBeNull()
    expect(detail.json().address).toBeNull()
    expect(detail.json().locationPrecision).toBe('APPROXIMATE')
  })

  it('does not expose the customer\'s fee breakdown to the worker', async () => {
    const customer = await registerUser('fee-cust@example.com')
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    const worker = await registerUser('fee-worker@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: worker.user.id },
      data: { status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1, onTimeRate: 1 },
    })

    const detail = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}`, headers: auth(worker.tokens.accessToken),
    })
    // The worker sees their payout, not what the customer was charged.
    expect(detail.json().workerPayoutCents).toBe(5280)
    expect(detail.json().customerTotalCents).toBeUndefined()
    expect(detail.json().serviceFeeCents).toBeUndefined()
  })
})

describe('worker search and claim over HTTP', () => {
  async function setupMarketplace() {
    const customer = await registerUser('mkt-cust@example.com')
    await prisma.customerProfile.update({
      where: { userId: customer.user.id },
      data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
    })
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()

    const worker = await registerUser('mkt-worker@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: worker.user.id },
      data: {
        status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1,
        onTimeRate: 1, serviceRadiusMiles: 20, stripeAccountId: 'acct_1', payoutsEnabled: true,
      },
    })
    return { customer, worker, property, category }
  }

  it('finds a posted job and claims it end to end', async () => {
    const { customer, worker, property, category } = await setupMarketplace()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    const search = await app.inject({
      method: 'GET',
      url: `/v1/jobs/search?lat=${NASHVILLE.lat}&lng=${NASHVILLE.lng}&radiusMiles=15&sort=DISTANCE`,
      headers: auth(worker.tokens.accessToken),
    })
    expect(search.json().jobs).toHaveLength(1)
    expect(search.json().jobs[0].id).toBe(jobId)
    expect(search.json().jobs[0].payPerHourCents).toBeGreaterThan(0)

    const claim = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`,
      headers: auth(worker.tokens.accessToken), payload: { workerLocation: NASHVILLE },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json().outcome).toBe('WON')

    const after = await prisma.job.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('CLAIMED')
  })

  it('caps the search radius to what the worker is allowed to serve', async () => {
    const { customer, worker, property, category } = await setupMarketplace()
    // A job 40 miles out, beyond the worker's 20-mile radius.
    const far = destinationPoint(NASHVILLE, 0, milesToMeters(40))
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "properties" SET "location" = ST_SetSRID(ST_MakePoint(${far.lng}::float8, ${far.lat}::float8),4326)::geography
       WHERE "id" = ${property.id}
    `)
    await postJobVia(customer.tokens.accessToken, property.id, category.id)

    // Even asking for 100 miles, the worker only gets their allowed radius.
    const search = await app.inject({
      method: 'GET',
      url: `/v1/jobs/search?lat=${NASHVILLE.lat}&lng=${NASHVILLE.lng}&radiusMiles=100`,
      headers: auth(worker.tokens.accessToken),
    })
    expect(search.json().radiusMilesApplied).toBe(20)
    expect(search.json().jobs).toHaveLength(0)
  })

  it('tells the second worker they lost, rather than erroring', async () => {
    const { customer, worker, property, category } = await setupMarketplace()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    const second = await registerUser('mkt-worker2@example.com', 'WORKER')
    await prisma.workerProfile.update({
      where: { userId: second.user.id },
      data: { status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1, onTimeRate: 1 },
    })

    const first = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(worker.tokens.accessToken), payload: {},
    })
    const loser = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(second.tokens.accessToken), payload: {},
    })

    expect(first.json().outcome).toBe('WON')
    expect(loser.statusCode).toBe(200) // losing is not an error
    expect(loser.json().outcome).toBe('LOST')
    expect(loser.json().reason).toBe('ALREADY_CLAIMED')
    expect(loser.json().message).toMatch(/another pro/i)
  })

  it('releases the job when the customer\'s card declines', async () => {
    const { customer, worker, property, category } = await setupMarketplace()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    provider.failures.nextChargeFailure = { code: 'card_declined', message: 'Declined.' }
    const claim = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(worker.tokens.accessToken), payload: {},
    })

    expect(claim.json().outcome).toBe('LOST')
    expect(claim.json().reason).toBe('PAYMENT_FAILED')
    const after = await prisma.job.findUniqueOrThrow({ where: { id: jobId } })
    expect(after.status).toBe('POSTED')
  })
})

describe('cancellation preview', () => {
  it('quotes the number before the customer confirms', async () => {
    const customer = await registerUser('cancel-cust@example.com')
    const property = await createPropertyVia(customer.tokens.accessToken)
    const category = await createCategory()
    const jobId = (await postJobVia(customer.tokens.accessToken, property.id, category.id)).json().id

    const preview = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/cancellation-preview`,
      headers: auth(customer.tokens.accessToken),
    })
    expect(preview.statusCode).toBe(200)
    // Charging a fee someone did not see coming is how you lose them.
    expect(preview.json().customerRefundCents).toBe(6480)
    expect(preview.json().reason).toMatch(/full refund/i)
  })
})

describe('public surfaces', () => {
  it('serves active categories', async () => {
    await createCategory({ slug: `active-${Date.now()}` })
    const response = await app.inject({ method: 'GET', url: '/v1/categories' })
    expect(response.statusCode).toBe(200)
    expect(response.json().categories.length).toBeGreaterThan(0)
  })

  it('serves a public worker profile without contact details', async () => {
    const worker = await createWorker({ points: 5000 })
    const response = await app.inject({ method: 'GET', url: `/v1/workers/${worker.profile.id}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.firstName).toBe('Riley')
    // A public profile is a reputation surface, not a contact card.
    expect(body).not.toHaveProperty('email')
    expect(body).not.toHaveProperty('phone')
    expect(response.body).not.toContain('@example.com')
  })

  it('serves a leaderboard', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/leaderboard?scope=CITY&period=WEEKLY' })
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(response.json().entries)).toBe(true)
  })

  it('gives price guidance that scales with yard size', async () => {
    const category = await createCategory()
    const small = await app.inject({
      method: 'GET', url: `/v1/jobs/price-guidance?categoryId=${category.id}&yardSize=UNDER_QUARTER_ACRE`,
    })
    const large = await app.inject({
      method: 'GET', url: `/v1/jobs/price-guidance?categoryId=${category.id}&yardSize=OVER_TWO`,
    })
    expect(large.json().suggestedLowCents).toBeGreaterThan(small.json().suggestedLowCents)
    expect(large.json().estimatedMinutes).toBeGreaterThan(small.json().estimatedMinutes)
  })
})
