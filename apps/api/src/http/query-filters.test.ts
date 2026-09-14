import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma, resetDatabase, createCategory, NASHVILLE } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { RANKS } from '@grassassassin/shared'

/**
 * Query-string filters.
 *
 * HTTP query strings carry only strings. A schema written for a JSON body —
 * z.boolean(), z.array() — rejects them, and z.coerce.boolean() is worse than
 * useless because Boolean("false") is true.
 *
 * These tests exercise the filters the way the worker map actually calls them:
 * over the wire, as a query string.
 */

let app: FastifyInstance
let token: string
let workerToken: string
let categoryId: string
let otherCategoryId: string

beforeAll(async () => {
  await prisma.$connect()
  app = await buildServer({
    db: prisma,
    provider: new FakePaymentProvider(),
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

beforeEach(async () => {
  await resetDatabase()
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
    VALUES ('sa-q','Nashville','nashville',
      ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
      40, true, now(), now())
  `)

  const stamp = Date.now()
  const customer = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: `qc-${stamp}@test.com`, password: 'a-long-enough-password', firstName: 'C', intent: 'CUSTOMER' },
  })
  token = customer.json().tokens.accessToken

  const worker = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: `qw-${stamp}@test.com`, password: 'a-long-enough-password', firstName: 'W', intent: 'WORKER' },
  })
  workerToken = worker.json().tokens.accessToken
  await prisma.workerProfile.update({
    where: { userId: worker.json().user.id },
    data: { status: 'APPROVED', completedJobs: 30, averageRating: 4.9, completionRate: 1, onTimeRate: 1, serviceRadiusMiles: 25 },
  })

  categoryId = (await createCategory({ slug: `mow-${stamp}`, name: 'Mowing' })).id
  otherCategoryId = (await createCategory({ slug: `leaves-${stamp}`, name: 'Leaves' })).id

  const property = await app.inject({
    method: 'POST', url: '/v1/properties', headers: { authorization: `Bearer ${token}` },
    payload: {
      label: 'Home', addressLine1: '1 Test St', city: 'Nashville', state: 'TN',
      postalCode: '37201', location: NASHVILLE, yardSize: 'QUARTER_TO_HALF',
    },
  })
  const propertyId = property.json().id

  const post = (cat: string, title: string, equipmentProvided: boolean, hoursOut: number) =>
    app.inject({
      method: 'POST', url: '/v1/jobs', headers: { authorization: `Bearer ${token}` },
      payload: {
        propertyId, categoryId: cat, title, priceCents: 6000, equipmentProvided,
        dueAt: new Date(Date.now() + hoursOut * 3_600_000).toISOString(),
      },
    })

  await post(categoryId, 'Mow with their gear', true, 4)
  await post(categoryId, 'Mow with my gear', false, 4)
  await post(otherCategoryId, 'Leaves next week', false, 24 * 5)
})

const workerAuth = () => ({ authorization: `Bearer ${workerToken}` })

const search = (query: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/jobs/search?lat=${NASHVILLE.lat}&lng=${NASHVILLE.lng}&radiusMiles=20&${query}`,
    headers: workerAuth(),
  })

describe('boolean filters over a query string', () => {
  it('accepts equipmentProvided=true and returns only those jobs', async () => {
    const response = await search('equipmentProvided=true')

    expect(response.statusCode, `body: ${response.body}`).toBe(200)
    const titles = response.json().jobs.map((j: { title: string }) => j.title)
    expect(titles).toEqual(['Mow with their gear'])
  })

  it('accepts equipmentProvided=false and returns the OTHER jobs', async () => {
    // Boolean("false") === true, so a coerce-based schema silently returns the
    // wrong set here rather than failing loudly.
    const response = await search('equipmentProvided=false')

    expect(response.statusCode, `body: ${response.body}`).toBe(200)
    const titles = response.json().jobs.map((j: { title: string }) => j.title).sort()
    expect(titles).toEqual(['Leaves next week', 'Mow with my gear'])
  })

  it('accepts dueToday=true, in the WORKER\'s timezone', async () => {
    // tzOffsetMinutes=360 is US Central, where the marketplace launches.
    // Without it, "today" would mean today on the server, and a job due at
    // 00:35 UTC would be invisible to a worker for whom it is still this evening.
    const response = await search('dueToday=true&tzOffsetMinutes=360')
    expect(response.statusCode, `body: ${response.body}`).toBe(200)
    // The two 4-hour jobs are due today; the 5-day job is not.
    expect(response.json().jobs).toHaveLength(2)
  })

  it('rejects an implausible timezone offset', async () => {
    const response = await search('dueToday=true&tzOffsetMinutes=99999')
    expect(response.statusCode).toBe(400)
  })

  it('treats dueToday=false as no filter rather than as true', async () => {
    const response = await search('dueToday=false&tzOffsetMinutes=360')
    expect(response.statusCode).toBe(200)
    expect(response.json().jobs).toHaveLength(3)
  })

  it('rejects a boolean that is neither true nor false', async () => {
    const response = await search('equipmentProvided=yes-please')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_ERROR')
  })
})

describe('array filters over a query string', () => {
  it('accepts a single categoryIds value', async () => {
    // A single-value query param arrives as a string, not an array.
    const response = await search(`categoryIds=${otherCategoryId}`)

    expect(response.statusCode, `body: ${response.body}`).toBe(200)
    const titles = response.json().jobs.map((j: { title: string }) => j.title)
    expect(titles).toEqual(['Leaves next week'])
  })

  it('accepts repeated categoryIds values', async () => {
    const response = await search(`categoryIds=${categoryId}&categoryIds=${otherCategoryId}`)
    expect(response.statusCode, `body: ${response.body}`).toBe(200)
    expect(response.json().jobs).toHaveLength(3)
  })
})

describe('numeric filters over a query string', () => {
  it('accepts minPayoutCents', async () => {
    const response = await search('minPayoutCents=10000')
    expect(response.statusCode).toBe(200)
    expect(response.json().jobs).toHaveLength(0)
  })

  it('rejects a non-numeric radius rather than silently defaulting', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/jobs/search?lat=${NASHVILLE.lat}&lng=${NASHVILLE.lng}&radiusMiles=lots`,
      headers: workerAuth(),
    })
    expect(response.statusCode).toBe(400)
  })

  it('rejects a missing latitude', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/jobs/search?lng=-86.78', headers: workerAuth(),
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('/jobs/mine active filter', () => {
  it('returns all jobs when active is not specified', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/jobs/mine?role=CUSTOMER', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().jobs).toHaveLength(3)
  })

  it('treats active=false as "do not filter", not as "filter to active"', async () => {
    // Boolean("false") === true is the classic coercion trap.
    const response = await app.inject({
      method: 'GET', url: '/v1/jobs/mine?role=CUSTOMER&active=false',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().jobs).toHaveLength(3)
  })
})
