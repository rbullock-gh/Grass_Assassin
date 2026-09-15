import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma, resetDatabase, createCategory, NASHVILLE, markEmailVerified } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { RANKS } from '@grassassassin/shared'

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
  // The service-area gate must be open or property creation fails first.
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "service_areas" ("id","name","slug","centerLocation","radiusMiles","active","createdAt","updatedAt")
    VALUES ('sa-test','Nashville','nashville',
      ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
      40, true, now(), now())
  `)
})

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

async function registerUser(email: string, firstName: string, intent: 'CUSTOMER' | 'WORKER') {
  const response = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email, password: 'a-sufficiently-long-password', firstName, intent },
  })
  expect(response.statusCode).toBe(201)
  const body = response.json() as { user: { id: string }; tokens: { accessToken: string } }
  // Posting and claiming both need a verified address; that is not what this
  // file is testing.
  await markEmailVerified(body.user.id)
  return body
}

/** Posts a job and gets it claimed, which is what opens a conversation. */
async function claimedJob() {
  const customer = await registerUser('msg-cust@example.com', 'Casey', 'CUSTOMER')
  const worker = await registerUser('msg-worker@example.com', 'Wade', 'WORKER')

  const property = await app.inject({
    method: 'POST', url: '/v1/properties', headers: auth(customer.tokens.accessToken),
    payload: {
      label: 'Home', addressLine1: '742 Evergreen Terrace', city: 'Nashville',
      state: 'TN', postalCode: '37201', location: NASHVILLE, yardSize: 'QUARTER_TO_HALF',
    },
  })
  const category = await createCategory()
  const job = await app.inject({
    method: 'POST', url: '/v1/jobs', headers: auth(customer.tokens.accessToken),
    payload: {
      propertyId: property.json().id, categoryId: category.id, priceCents: 6000,
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    },
  })

  await prisma.workerProfile.update({
    where: { userId: worker.user.id },
    data: {
      status: 'APPROVED', completedJobs: 30, averageRating: 4.9, ratingCount: 20,
      completionRate: 1, onTimeRate: 1, stripeAccountId: 'acct_1', payoutsEnabled: true,
    },
  })
  await prisma.customerProfile.update({
    where: { userId: customer.user.id },
    data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
  })

  const jobId = job.json().id
  const claim = await app.inject({
    method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: auth(worker.tokens.accessToken), payload: {},
  })
  expect(claim.json().outcome).toBe('WON')

  return { customer, worker, jobId }
}

describe('messaging', () => {
  it('opens a thread when the claim completes, not before', async () => {
    // Without this a worker is standing on a lawn with a question and no way
    // to ask it — which is the whole reason the privacy promise is keepable.
    const { customer, jobId } = await claimedJob()
    const thread = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/messages`, headers: auth(customer.tokens.accessToken),
    })
    expect(thread.statusCode).toBe(200)
    expect(thread.json().open).toBe(true)
    expect(thread.json().messages).toEqual([])
    expect(thread.json().counterpart.firstName).toBe('Wade')
  })

  it('delivers a message both ways', async () => {
    const { customer, worker, jobId } = await claimedJob()

    const sent = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'On my way, about 15 minutes out' },
    })
    expect(sent.statusCode).toBe(201)
    expect(sent.json().notice).toBeNull()

    const read = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/messages`, headers: auth(customer.tokens.accessToken),
    })
    expect(read.json().messages).toHaveLength(1)
    expect(read.json().messages[0].body).toBe('On my way, about 15 minutes out')
  })

  it('never lets a third party read or write the thread', async () => {
    // A conversation is a private channel about one property. Anyone else
    // reading it learns where a stranger lives and when they are out.
    const { jobId } = await claimedJob()
    const nosy = await registerUser('nosy@example.com', 'Nosy', 'WORKER')

    const read = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/messages`, headers: auth(nosy.tokens.accessToken),
    })
    expect(read.statusCode).toBe(403)

    const write = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(nosy.tokens.accessToken),
      payload: { body: 'hello?' },
    })
    expect(write.statusCode).toBe(403)

    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: auth(nosy.tokens.accessToken),
    })
    expect(list.json().conversations).toEqual([])
  })

  it('refuses an unauthenticated read', async () => {
    const { jobId } = await claimedJob()
    const read = await app.inject({ method: 'GET', url: `/v1/jobs/${jobId}/messages` })
    expect(read.statusCode).toBe(401)
  })

  it('FLAGS a phone number but still delivers it', async () => {
    // Blocking pushes the conversation to SMS, which is the leak the check
    // exists to prevent. The message lands; a human reviews the flag.
    const { customer, worker, jobId } = await claimedJob()

    const sent = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'text me at 615-555-0123 and we can skip the fee' },
    })
    expect(sent.statusCode).toBe(201)
    expect(sent.json().notice).toContain('payment protection')

    const stored = await prisma.message.findFirst({ where: { id: sent.json().message.id } })
    expect(stored!.flagged).toBe(true)
    expect(stored!.flagReason).toContain('PHONE_NUMBER')

    const read = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/messages`, headers: auth(customer.tokens.accessToken),
    })
    expect(read.json().messages).toHaveLength(1)
  })

  it('does not flag ordinary job talk', async () => {
    const { worker, jobId } = await claimedJob()
    const sent = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'Finished the front. $120.00 covers the back too if you want it.' },
    })
    expect(sent.json().notice).toBeNull()
    const stored = await prisma.message.findFirst({ where: { id: sent.json().message.id } })
    expect(stored!.flagged).toBe(false)
  })

  it('counts unread messages for the recipient only', async () => {
    const { customer, worker, jobId } = await claimedJob()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'Question about the gate' },
    })

    const workerList = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: auth(worker.tokens.accessToken),
    })
    // Your own message is not unread for you.
    expect(workerList.json().conversations[0].unreadCount).toBe(0)

    const customerList = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: auth(customer.tokens.accessToken),
    })
    expect(customerList.json().conversations[0].unreadCount).toBe(1)
  })

  it('clears unread once the thread is opened', async () => {
    const { customer, worker, jobId } = await claimedJob()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'Gate?' },
    })
    await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/messages`, headers: auth(customer.tokens.accessToken),
    })
    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: auth(customer.tokens.accessToken),
    })
    expect(list.json().conversations[0].unreadCount).toBe(0)
  })

  it('closes the thread a week after the job ends', async () => {
    const { worker, jobId } = await claimedJob()
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'CLOSED', closedAt: new Date(Date.now() - 8 * 86_400_000) },
    })

    const read = await app.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
    })
    expect(read.json().open).toBe(false)
    expect(read.json().closedReason).toContain('Post a new job')

    const write = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'still there?' },
    })
    expect(write.statusCode).toBe(409)
  })

  it('keeps the thread open in the week right after the job ends', async () => {
    // A gate left open, a missed spot, a question about a tip.
    const { worker, jobId } = await claimedJob()
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'CLOSED', closedAt: new Date(Date.now() - 2 * 86_400_000) },
    })
    const write = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'You left the side gate open, just letting you know' },
    })
    expect(write.statusCode).toBe(201)
  })

  it('rejects an empty or oversized message', async () => {
    const { worker, jobId } = await claimedJob()
    for (const body of ['', '   ', 'x'.repeat(2001)]) {
      const sent = await app.inject({
        method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
        payload: { body },
      })
      expect(sent.statusCode, JSON.stringify(body.slice(0, 20))).toBe(400)
    }
  })

  it('404s a job that has no conversation rather than inventing one', async () => {
    // An unclaimed job has no thread — there is nobody on the other end.
    const customer = await registerUser('lonely@example.com', 'Casey', 'CUSTOMER')
    const read = await app.inject({
      method: 'GET', url: '/v1/jobs/does-not-exist/messages', headers: auth(customer.tokens.accessToken),
    })
    expect(read.statusCode).toBe(404)
  })

  it('never puts the message body in the push notification', async () => {
    // A lock screen is a public surface. A gate code on it defeats the point
    // of withholding the address in the first place.
    const { worker, jobId } = await claimedJob()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/messages`, headers: auth(worker.tokens.accessToken),
      payload: { body: 'Gate code is 4417' },
    })
    const notification = await prisma.notification.findFirst({
      where: { type: 'NEW_MESSAGE' },
      orderBy: { createdAt: 'desc' },
    })
    expect(notification).not.toBeNull()
    expect(JSON.stringify(notification)).not.toContain('4417')
  })
})
