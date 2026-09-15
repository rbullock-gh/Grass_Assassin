import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma, resetDatabase, createCategory, createCustomer, NASHVILLE } from '../../test/factories.js'
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

describe('a client mistake is reported as a client mistake', () => {
  /**
   * Fastify rejects some requests before any handler runs, with its own error
   * carrying a 4xx statusCode. Those used to fall through to the catch-all and
   * come back as 500 INTERNAL_ERROR, logged at error level as "Unhandled
   * error" — so a malformed request was indistinguishable, in the logs and to
   * the caller, from the server falling over.
   *
   * Found by hand, sending a DELETE from a script. inject() does not set a
   * content-type for an empty body, so no test had ever produced one.
   */
  it('answers an empty JSON body with 400, not 500', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/blocks/someone',
      headers: { authorization: 'Bearer nonsense', 'content-type': 'application/json' },
    })
    expect(response.statusCode).not.toBe(500)
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.statusCode).toBeLessThan(500)
  })

  it('answers unparseable JSON with 400, not 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": "nope"',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBeTruthy()
  })

  it('still says nothing revealing in the message', async () => {
    // The code is passed through because Fastify's are machine-readable. The
    // message is not, because Fastify's can name internals.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{ broken',
    })
    expect(response.json().error.message).toBe('The request was not valid')
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

  /**
   * The same question, asked of the server instead of the list above.
   *
   * The list is readable and worth keeping, and it is also the kind of thing
   * people forget: /v1/devices was added, shipped and tested without anyone
   * adding it here, and the suite stayed green. This walks every route the
   * server actually registered and requires each one to be either in the
   * public allowlist below or to refuse an anonymous caller — so forgetting is
   * a failure rather than a silence.
   */
  const PUBLIC_BY_DESIGN = new Set([
    'GET /health',
    'GET /v1/categories',
    'GET /v1/equipment',
    'GET /v1/leaderboard',
    'GET /v1/workers/:id',
    // Sign-up, sign-in and token refresh cannot require a token.
    'POST /v1/auth/register',
    'POST /v1/auth/login',
    'POST /v1/auth/refresh',
    'POST /v1/auth/logout',
    // Signed with Stripe's own secret and verified in the handler; a bearer
    // token is not a thing Stripe has.
    'POST /v1/webhooks/stripe',
    // Guarded by a service token plus an acting-admin lookup, not a user JWT.
    'POST /v1/admin/disputes/:id/resolve',
    /*
     * Deliberately public, decided when this check first surfaced it.
     *
     * It answers "what does a mow cost around here" from category averages and
     * a lot-size multiplier — the same data /v1/categories already serves to
     * anyone. Someone deciding whether to sign up should be able to ask, and
     * there is no personal data in the answer.
     */
    'GET /v1/jobs/price-guidance',
    /*
     * Development only — the module refuses to register against real storage
     * and against isProduction, so these do not exist in production at all.
     * They authenticate with the presigned signature the upload was granted,
     * not with a user's token, which is exactly what S3 does.
     */
    'PUT /dev-storage/*',
    'GET /dev-storage/*',
  ])

  it('leaves no route both unlisted and unprotected', async () => {
    const unprotected: string[] = []

    for (const route of app.routeManifest) {
      const key = `${route.method} ${route.url}`
      if (PUBLIC_BY_DESIGN.has(key)) continue
      if (route.url === '*') continue

      // A concrete value for every parameter, so the request reaches a handler
      // rather than failing to route.
      const url = route.url.replace(/:[A-Za-z0-9_]+/g, 'anything')
      const response = await app.inject({
        method: route.method as 'GET',
        url,
        ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { payload: {} }),
      })

      // 401 is the point. 400 would mean validation ran before the auth check,
      // which leaks whether a body shape is right to an anonymous caller — and
      // 404 on a route that exists means it never reached requireIdentity.
      if (response.statusCode !== 401) {
        unprotected.push(`${key} → ${response.statusCode}`)
      }
    }

    expect(
      unprotected,
      'These routes answered an anonymous caller with something other than 401. ' +
      'Either add requireIdentity, or add them to PUBLIC_BY_DESIGN with a reason.',
    ).toEqual([])
  })
})

/** A real access token for a factory-made user. */
async function tokenFor(userId: string): Promise<string> {
  const { signAccessToken } = await import('../modules/auth/tokens.js')
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId }, select: { id: true, roles: true },
  })
  return signAccessToken({
    userId: user.id, roles: user.roles,
    secret: 'test-access-secret-at-least-32-characters-long', ttlSeconds: 900,
  })
}

describe('an account state change takes effect at once', () => {
  /**
   * A signed token says who somebody WAS when it was issued. It cannot say
   * whether they have since been banned, suspended or deleted — and this used
   * to accept it anyway, so every account-state change was soft for the life of
   * the token: a worker banned over a safety report kept working for fifteen
   * minutes.
   *
   * Found by the account-deletion test asserting the old token stopped working,
   * and it did not.
   */
  it('stops a deleted account with an unexpired token', async () => {
    const customer = await createCustomer()
    const token = await tokenFor(customer.id)
    expect((await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(200)

    await prisma.user.update({ where: { id: customer.id }, data: { deletedAt: new Date() } })

    expect((await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(401)
  })

  it('stops a suspended account with an unexpired token', async () => {
    const customer = await createCustomer()
    const token = await tokenFor(customer.id)
    await prisma.user.update({
      where: { id: customer.id },
      data: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + 86_400_000) },
    })

    expect((await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(401)
  })

  it('lets somebody back in once a suspension expires', async () => {
    const customer = await createCustomer()
    const token = await tokenFor(customer.id)
    await prisma.user.update({
      where: { id: customer.id },
      data: { suspendedUntil: new Date(Date.now() - 1000) },
    })

    expect((await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(200)
  })

  it('takes roles from the account rather than the token', async () => {
    // A role granted after sign-in should work without signing in again, and a
    // role removed should stop working without waiting for the token to lapse.
    const customer = await createCustomer()
    const token = await tokenFor(customer.id)
    await prisma.user.update({
      where: { id: customer.id }, data: { roles: ['CUSTOMER', 'WORKER'] },
    })

    const me = await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` },
    })
    expect(me.json().roles).toContain('WORKER')
  })
})
