import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma, resetDatabase, createCategory, NASHVILLE } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { RANKS } from '@grassassassin/shared'

/**
 * Route shadowing.
 *
 * `/jobs/mine` is registered AFTER `/jobs/:id`, and several literal routes sit
 * under paths that also have a parameterised sibling. Fastify's router prefers
 * static segments over parameters regardless of registration order — but that
 * is a property of the router, not of our code, and a refactor to a different
 * framework or a router option change would silently turn `/jobs/mine` into a
 * lookup for a job whose id is the string "mine".
 *
 * These assert the behaviour rather than trusting it.
 */

let app: FastifyInstance
let token: string

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
    VALUES ('sa-route','Nashville','nashville',
      ST_SetSRID(ST_MakePoint(${NASHVILLE.lng}::float8, ${NASHVILLE.lat}::float8),4326)::geography,
      40, true, now(), now())
  `)

  const response = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: `route-${Date.now()}@test.com`, password: 'a-long-enough-password', firstName: 'R', intent: 'CUSTOMER' },
  })
  token = response.json().tokens.accessToken
})

const auth = () => ({ authorization: `Bearer ${token}` })

describe('literal routes are not shadowed by parameterised siblings', () => {
  it('routes /jobs/mine to the list, not to a job whose id is "mine"', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/jobs/mine?role=CUSTOMER', headers: auth() })

    expect(response.statusCode).toBe(200)
    // The shadowed outcome would be a 404 "Job not found" from /jobs/:id.
    expect(response.json()).toHaveProperty('jobs')
    expect(Array.isArray(response.json().jobs)).toBe(true)
  })

  it('routes /jobs/search to the search handler', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/jobs/search?lat=${NASHVILLE.lat}&lng=${NASHVILLE.lng}&radiusMiles=10`,
      headers: auth(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('jobs')
    expect(response.json()).toHaveProperty('radiusMilesApplied')
  })

  it('routes /jobs/price-guidance to the guidance handler', async () => {
    const category = await createCategory()
    const response = await app.inject({
      method: 'GET', url: `/v1/jobs/price-guidance?categoryId=${category.id}`, headers: auth(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('suggestedLowCents')
  })

  it('still routes a real job id to the detail handler', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/jobs/some-real-looking-id', headers: auth() })
    // 404 here is correct — the id does not exist. What matters is that it
    // reached the detail handler rather than a list handler.
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('NOT_FOUND')
  })
})

describe('every route requires the authentication it should', () => {
  // A route that forgets requireIdentity leaks data to anyone with the URL.
  const protectedRoutes: Array<[string, string, unknown?]> = [
    ['GET', '/v1/me'],
    ['GET', '/v1/properties'],
    ['POST', '/v1/properties', {}],
    ['GET', '/v1/jobs/mine'],
    ['GET', '/v1/jobs/search?lat=36&lng=-86'],
    ['POST', '/v1/jobs', {}],
    ['GET', '/v1/jobs/anything'],
    ['POST', '/v1/jobs/anything/claim', {}],
    ['POST', '/v1/jobs/anything/status', {}],
    ['POST', '/v1/jobs/anything/cancel', {}],
    ['GET', '/v1/jobs/anything/cancellation-preview'],
    ['POST', '/v1/jobs/anything/review', {}],
    ['POST', '/v1/jobs/anything/tip', {}],
    ['GET', '/v1/worker/earnings'],
    ['PATCH', '/v1/worker/profile', {}],
    ['POST', '/v1/auth/logout-all'],
    ['POST', '/v1/auth/change-password', {}],
    ['POST', '/v1/auth/add-role', {}],
  ]

  for (const [method, url, payload] of protectedRoutes) {
    it(`${method} ${url} rejects an anonymous request`, async () => {
      const response = payload === undefined
        ? await app.inject({ method: method as 'GET', url })
        : await app.inject({ method: method as 'GET', url, payload: payload as object })
      expect(
        response.statusCode,
        `${method} ${url} returned ${response.statusCode} to an anonymous caller`,
      ).toBe(401)
    })
  }

  // These are intentionally public: a customer browses categories and a worker
  // profile before signing up, and the leaderboard is a marketing surface.
  const publicRoutes: Array<[string, string]> = [
    ['GET', '/health'],
    ['GET', '/v1/categories'],
    ['GET', '/v1/equipment'],
    ['GET', '/v1/leaderboard'],
  ]

  for (const [method, url] of publicRoutes) {
    it(`${method} ${url} is reachable without a token, by design`, async () => {
      const response = await app.inject({ method: method as 'GET', url })
      expect(response.statusCode).toBe(200)
    })
  }
})
