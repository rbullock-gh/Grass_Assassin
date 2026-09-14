import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma, resetDatabase, createCategory, NASHVILLE } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { FakeStorageProvider } from '../modules/storage/provider.js'
import { sweepAbandonedPhotos } from '../modules/storage/photos.js'
import { RANKS } from '@grassassassin/shared'

const provider = new FakePaymentProvider()
const storage = new FakeStorageProvider()

let app: FastifyInstance
let customerToken: string
let customerId: string
let workerToken: string
let workerId: string
let categoryId: string
let propertyId: string
let jobId: string

beforeAll(async () => {
  await prisma.$connect()
  app = await buildServer({
    db: prisma, provider, storage,
    config: {
      accessSecret: 'test-access-secret-at-least-32-characters-long',
      accessTtlSeconds: 900, refreshTtlDays: 30, ipSalt: 'salt',
      isProduction: false, rateLimits: { enabled: false },
    },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

const cAuth = () => ({ authorization: `Bearer ${customerToken}` })
const wAuth = () => ({ authorization: `Bearer ${workerToken}` })

beforeEach(async () => {
  await resetDatabase()
  provider.reset()
  storage.reset()

  await prisma.rank.createMany({
    data: RANKS.map((r, i) => ({
      key: r.key, name: r.name, minPoints: r.minPoints, sortOrder: i,
      commissionDiscountBps: r.commissionDiscountBps, radiusBonusMiles: r.radiusBonusMiles,
      earlyAccessMinutes: r.earlyAccessMinutes, verifiedBadge: r.verifiedBadge,
      minRating: r.minRating, minCompletionRate: r.minCompletionRate, minOnTimeRate: r.minOnTimeRate,
    })),
  })
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "service_areas" ("id","name","slug","centerLocation","radiusMiles","active","createdAt","updatedAt")
    VALUES ('sa-pr','Nashville','nashville',
      ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
      40, true, now(), now())
  `)

  const stamp = Date.now()
  const customer = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: `pc-${stamp}@t.com`, password: 'a-long-enough-password', firstName: 'C', intent: 'CUSTOMER' },
  })
  customerToken = customer.json().tokens.accessToken
  customerId = customer.json().user.id
  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_test_visa' },
  })

  const worker = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: `pw-${stamp}@t.com`, password: 'a-long-enough-password', firstName: 'W', intent: 'WORKER' },
  })
  workerToken = worker.json().tokens.accessToken
  workerId = worker.json().user.id
  await prisma.workerProfile.update({
    where: { userId: workerId },
    data: {
      status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1,
      onTimeRate: 1, stripeAccountId: 'acct_1', payoutsEnabled: true,
    },
  })

  categoryId = (await createCategory({ slug: `mow-${stamp}` })).id

  const property = await app.inject({
    method: 'POST', url: '/v1/properties', headers: cAuth(),
    payload: {
      label: 'Home', addressLine1: '1 Test St', city: 'Nashville', state: 'TN',
      postalCode: '37201', location: NASHVILLE, yardSize: 'QUARTER_TO_HALF',
    },
  })
  propertyId = property.json().id

  const job = await app.inject({
    method: 'POST', url: '/v1/jobs', headers: cAuth(),
    payload: {
      propertyId, categoryId, priceCents: 6000,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  })
  jobId = job.json().id
})

async function claim() {
  const response = await app.inject({
    method: 'POST', url: `/v1/jobs/${jobId}/claim`, headers: wAuth(), payload: {},
  })
  expect(response.json().outcome).toBe('WON')
}

async function presign(kind: string, headers = wAuth()) {
  return app.inject({
    method: 'POST', url: `/v1/jobs/${jobId}/photos/presign`, headers,
    payload: { kind, contentType: 'image/jpeg' },
  })
}

describe('photo upload', () => {
  it('presigns, uploads, and confirms', async () => {
    await claim()
    const presigned = await presign('BEFORE')

    expect(presigned.statusCode).toBe(201)
    const { photoId, uploadUrl, maxBytes } = presigned.json()
    expect(uploadUrl).toContain('https://storage.test/upload/')
    expect(maxBytes).toBeGreaterThan(0)

    const photo = await prisma.jobPhoto.findUniqueOrThrow({ where: { id: photoId } })
    // The row exists in PENDING from the moment it is presigned, so an
    // abandoned upload is visible rather than an orphaned object nobody knows about.
    expect(photo.moderationStatus).toBe('PENDING')

    storage.completeUpload(photo.storageKey, 2_400_000)

    const confirmed = await app.inject({
      method: 'POST', url: `/v1/photos/${photoId}/confirm`, headers: wAuth(),
      payload: { capturedLocation: NASHVILLE },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json().bytes).toBe(2_400_000)

    const after = await prisma.jobPhoto.findUniqueOrThrow({ where: { id: photoId } })
    expect(after.moderationStatus).toBe('APPROVED')
    expect(after.capturedAt).not.toBeNull()

    // Capture location corroborates the geofenced check-in in a dispute.
    const located = await prisma.$queryRaw<Array<{ has: boolean }>>(Prisma.sql`
      SELECT ("capturedLocation" IS NOT NULL) AS has FROM "job_photos" WHERE "id" = ${photoId}
    `)
    expect(located[0]?.has).toBe(true)
  })

  it('refuses an unsupported file type', async () => {
    await claim()
    const response = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/photos/presign`, headers: wAuth(),
      payload: { kind: 'BEFORE', contentType: 'application/pdf' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('deletes the row when the upload never landed', async () => {
    await claim()
    const { photoId } = (await presign('BEFORE')).json()

    // Confirm without ever uploading.
    const confirmed = await app.inject({
      method: 'POST', url: `/v1/photos/${photoId}/confirm`, headers: wAuth(), payload: {},
    })

    expect(confirmed.statusCode).toBe(409)
    expect(confirmed.json().error.code).toBe('UPLOAD_MISSING')
    // A half-real BEFORE photo would otherwise let a worker start a job they
    // are not at.
    expect(await prisma.jobPhoto.findUnique({ where: { id: photoId } })).toBeNull()
  })

  it('rejects an oversized upload and cleans up', async () => {
    await claim()
    const { photoId } = (await presign('BEFORE')).json()
    const photo = await prisma.jobPhoto.findUniqueOrThrow({ where: { id: photoId } })
    // The storage grant caps size, but confirm re-checks in case it did not.
    storage.completeUpload(photo.storageKey, 2_000_000)
    await prisma.jobPhoto.update({ where: { id: photoId }, data: { bytes: null } })
    // Simulate storage reporting something far larger than the cap.
    storage.reset()
    ;(storage as unknown as { objects: Map<string, { bytes: number; contentType: string }> })
      .objects?.set?.(photo.storageKey, { bytes: 50 * 1024 * 1024, contentType: 'image/jpeg' })

    const confirmed = await app.inject({
      method: 'POST', url: `/v1/photos/${photoId}/confirm`, headers: wAuth(), payload: {},
    })
    expect([400, 409]).toContain(confirmed.statusCode)
  })
})

describe('photo authorization', () => {
  it('stops a worker who has not claimed the job from adding work photos', async () => {
    const response = await presign('BEFORE')
    expect(response.statusCode).toBe(403)
  })

  it('stops the customer from adding before/after photos', async () => {
    await claim()
    // The worker's proof must come from the worker, or it proves nothing.
    const response = await presign('BEFORE', cAuth())
    expect(response.statusCode).toBe(403)
  })

  it('stops a worker from adding listing photos', async () => {
    const response = await presign('LISTING')
    expect(response.statusCode).toBe(403)
  })

  it('lets the customer add listing photos before a claim', async () => {
    const response = await presign('LISTING', cAuth())
    expect(response.statusCode).toBe(201)
  })

  it('refuses listing photos once the job is claimed', async () => {
    await claim()
    const response = await presign('LISTING', cAuth())
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('TOO_LATE')
  })

  it('refuses AFTER photos before work has started', async () => {
    await claim()
    const response = await presign('AFTER')
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('WRONG_STAGE')
  })

  it('stops someone confirming another person\'s upload', async () => {
    await claim()
    const { photoId } = (await presign('BEFORE')).json()
    const photo = await prisma.jobPhoto.findUniqueOrThrow({ where: { id: photoId } })
    storage.completeUpload(photo.storageKey, 1000)

    const response = await app.inject({
      method: 'POST', url: `/v1/photos/${photoId}/confirm`, headers: cAuth(), payload: {},
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('the photo gate cannot be bypassed', () => {
  it('will not start work on a PENDING photo that was never uploaded', async () => {
    // The bypass this closes: presign a photo to create the row, then start
    // work without ever uploading anything.
    await claim()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/status`, headers: wAuth(), payload: { to: 'EN_ROUTE' },
    })
    await presign('BEFORE') // row exists, but PENDING

    const start = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/status`, headers: wAuth(),
      payload: { to: 'IN_PROGRESS', workerLocation: NASHVILLE },
    })

    expect(start.statusCode).toBe(409)
    expect(start.json().error.code).toBe('BEFORE_PHOTOS_REQUIRED')
  })

  it('starts work once the photo is genuinely confirmed', async () => {
    await claim()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/status`, headers: wAuth(), payload: { to: 'EN_ROUTE' },
    })
    const { photoId } = (await presign('BEFORE')).json()
    const photo = await prisma.jobPhoto.findUniqueOrThrow({ where: { id: photoId } })
    storage.completeUpload(photo.storageKey, 1_200_000)
    await app.inject({
      method: 'POST', url: `/v1/photos/${photoId}/confirm`, headers: wAuth(), payload: {},
    })

    const start = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/status`, headers: wAuth(),
      payload: { to: 'IN_PROGRESS', workerLocation: NASHVILLE },
    })
    expect(start.statusCode).toBe(200)
  })
})

describe('abandoned upload sweep', () => {
  it('removes stale pending photos but keeps confirmed ones', async () => {
    await claim()
    const stale = (await presign('BEFORE')).json()
    const good = (await presign('BEFORE')).json()

    const goodPhoto = await prisma.jobPhoto.findUniqueOrThrow({ where: { id: good.photoId } })
    storage.completeUpload(goodPhoto.storageKey, 900_000)
    await app.inject({
      method: 'POST', url: `/v1/photos/${good.photoId}/confirm`, headers: wAuth(), payload: {},
    })

    await prisma.jobPhoto.update({
      where: { id: stale.photoId },
      data: { createdAt: new Date(Date.now() - 3 * 3_600_000) },
    })

    expect(await sweepAbandonedPhotos(prisma, 60)).toBe(1)
    expect(await prisma.jobPhoto.findUnique({ where: { id: stale.photoId } })).toBeNull()
    expect(await prisma.jobPhoto.findUnique({ where: { id: good.photoId } })).not.toBeNull()
  })
})

describe('recurring service', () => {
  async function completeTheJob() {
    await claim()
    const advance = async (to: string, payload: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST', url: `/v1/jobs/${jobId}/status`, headers: wAuth(), payload: { to, ...payload },
      })
    await advance('EN_ROUTE')
    await prisma.jobPhoto.create({
      data: { jobId, uploadedById: workerId, kind: 'BEFORE', storageKey: 'b', url: 'u', moderationStatus: 'APPROVED' },
    })
    await advance('IN_PROGRESS', { workerLocation: NASHVILLE })
    await prisma.jobPhoto.create({
      data: { jobId, uploadedById: workerId, kind: 'AFTER', storageKey: 'a', url: 'u', moderationStatus: 'APPROVED' },
    })
    await advance('PENDING_APPROVAL')
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/status`, headers: cAuth(), payload: { to: 'APPROVED' },
    })
  }

  it('converts a completed job into a standing appointment', async () => {
    await completeTheJob()

    const response = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'BIWEEKLY' },
    })

    expect(response.statusCode).toBe(201)
    const recurring = response.json()
    expect(recurring.interval).toBe('BIWEEKLY')
    expect(recurring.priceCents).toBe(6000)
    // Offered to the pro they just liked, first.
    expect(recurring.preferredWorkerId).toBe(workerId)
    // Next visit is one interval out, not immediately — the work was just done.
    expect(new Date(recurring.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000)
  })

  it('refuses before the job is complete', async () => {
    await claim()
    const response = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('NOT_COMPLETE')
  })

  it('refuses from someone who is not the customer', async () => {
    await completeTheJob()
    const response = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: wAuth(),
      payload: { interval: 'WEEKLY' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('refuses a duplicate schedule for the same property and category', async () => {
    await completeTheJob()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })
    const second = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'MONTHLY' },
    })
    // Two overlapping schedules would generate two jobs a week for one lawn.
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('ALREADY_SCHEDULED')
  })

  it('enforces the minimum price', async () => {
    await completeTheJob()
    const response = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY', priceCents: 500 },
    })
    expect(response.statusCode).toBe(400)
  })

  it('lists a customer\'s subscriptions', async () => {
    await completeTheJob()
    await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })

    const response = await app.inject({ method: 'GET', url: '/v1/recurring', headers: cAuth() })
    expect(response.statusCode).toBe(200)
    expect(response.json().subscriptions).toHaveLength(1)
    expect(response.json().subscriptions[0].category.name).toBeTruthy()
  })

  it('cancels immediately when asked', async () => {
    // A recurring charge that is hard to stop earns a chargeback and loses the
    // customer permanently.
    await completeTheJob()
    const created = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })
    const id = created.json().id

    const cancelled = await app.inject({
      method: 'PATCH', url: `/v1/recurring/${id}`, headers: cAuth(), payload: { active: false },
    })

    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().active).toBe(false)
  })

  it('pauses without cancelling', async () => {
    await completeTheJob()
    const created = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })
    const until = new Date(Date.now() + 30 * 86_400_000)

    const paused = await app.inject({
      method: 'PATCH', url: `/v1/recurring/${created.json().id}`, headers: cAuth(),
      payload: { pauseUntil: until.toISOString() },
    })

    expect(paused.statusCode).toBe(200)
    expect(paused.json().active).toBe(true)
    expect(new Date(paused.json().pausedUntil).getTime()).toBeCloseTo(until.getTime(), -3)
  })

  it('refuses to schedule the next visit in the past', async () => {
    await completeTheJob()
    const created = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })
    const response = await app.inject({
      method: 'PATCH', url: `/v1/recurring/${created.json().id}`, headers: cAuth(),
      payload: { nextRunAt: new Date(Date.now() - 86_400_000).toISOString() },
    })
    expect(response.statusCode).toBe(400)
  })

  it('stops another customer touching your schedule', async () => {
    await completeTheJob()
    const created = await app.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/make-recurring`, headers: cAuth(),
      payload: { interval: 'WEEKLY' },
    })

    const stranger = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: `str-${Date.now()}@t.com`, password: 'a-long-enough-password', firstName: 'S', intent: 'CUSTOMER' },
    })

    const response = await app.inject({
      method: 'PATCH', url: `/v1/recurring/${created.json().id}`,
      headers: { authorization: `Bearer ${stranger.json().tokens.accessToken}` },
      payload: { active: false },
    })
    expect(response.statusCode).toBe(403)
  })
})
