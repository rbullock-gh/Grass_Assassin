import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma, resetDatabase } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { signAccessToken, verifyAccessToken } from '../modules/auth/tokens.js'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

/**
 * Rate-limit keying.
 *
 * The limiter is supposed to key on the authenticated user when there is one,
 * so that a shared NAT — an apartment block, an office, a coffee shop — does
 * not put every user into a single bucket and throttle them all because one
 * person is busy.
 *
 * That only works if the auth hook has already run when the limiter's
 * keyGenerator is called, which depends on plugin registration order. This
 * test pins the behaviour so a reordering cannot silently revert it to
 * IP-only keying.
 */

const SECRET = 'test-access-secret-at-least-32-characters-long'
let app: FastifyInstance

beforeAll(async () => {
  await prisma.$connect()
  await resetDatabase()
  app = await buildServer({
    db: prisma,
    provider: new FakePaymentProvider(),
    config: {
      accessSecret: SECRET, accessTtlSeconds: 900, refreshTtlDays: 30,
      ipSalt: 'salt', isProduction: false,
      // A tiny global budget makes the keying observable in a few requests.
      rateLimits: { enabled: true, globalMax: 4, registerMax: 50, loginMax: 50, claimMax: 50 },
    },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

async function tokenFor(userId: string) {
  return signAccessToken({ userId, roles: ['CUSTOMER'], secret: SECRET, ttlSeconds: 900 })
}

describe('rate limiting keys on the user, not only the IP', () => {
  it('does not let one busy user exhaust another user\'s budget from the same IP', async () => {
    const alice = await tokenFor('user-alice')
    const bob = await tokenFor('user-bob')

    // Alice burns through the global budget. Both requests come from the same
    // simulated IP, as they would behind one NAT.
    const aliceStatuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({
        method: 'GET', url: '/v1/categories',
        headers: { authorization: `Bearer ${alice}`, 'x-forwarded-for': '203.0.113.9' },
      })
      aliceStatuses.push(response.statusCode)
    }
    expect(aliceStatuses, 'Alice should have been throttled').toContain(429)

    // Bob, on the same IP, must still be served. If the limiter keyed only on
    // IP, this would already be 429.
    const bobResponse = await app.inject({
      method: 'GET', url: '/v1/categories',
      headers: { authorization: `Bearer ${bob}`, 'x-forwarded-for': '203.0.113.9' },
    })

    expect(
      bobResponse.statusCode,
      'Bob was throttled by Alice\'s usage — the limiter is keying on IP, not on the user',
    ).toBe(200)
  })

  it('still falls back to the IP for anonymous callers', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({
        method: 'GET', url: '/v1/categories',
        headers: { 'x-forwarded-for': '198.51.100.7' },
      })
      statuses.push(response.statusCode)
    }
    // Anonymous traffic has no user to key on, so the IP must still bound it.
    expect(statuses).toContain(429)
  })
})

describe('negative control: the test would catch IP-only keying', () => {
  it('shows an IP-keyed limiter DOES let one user exhaust another\'s budget', async () => {
    // A green test above proves nothing unless it would fail on the broken
    // configuration. This builds the same limiter keyed only on IP — the
    // mistake a reordering would produce — and asserts the collateral damage
    // the real configuration avoids.
    const broken = Fastify({ trustProxy: true, logger: false })
    await broken.register(rateLimit, {
      max: 4,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.ip, // the bug
    })
    broken.addHook('onRequest', async (request) => {
      const header = request.headers.authorization
      if (!header?.startsWith('Bearer ')) return
      try {
        const claims = await verifyAccessToken(header.slice(7), SECRET)
        request.identity = { userId: claims.sub, roles: claims.roles }
      } catch { /* anonymous */ }
    })
    broken.get('/v1/categories', async () => ({ categories: [] }))
    await broken.ready()

    const alice = await tokenFor('user-alice-2')
    const bob = await tokenFor('user-bob-2')

    for (let i = 0; i < 6; i++) {
      await broken.inject({
        method: 'GET', url: '/v1/categories',
        headers: { authorization: `Bearer ${alice}`, 'x-forwarded-for': '203.0.113.9' },
      })
    }

    const bobResponse = await broken.inject({
      method: 'GET', url: '/v1/categories',
      headers: { authorization: `Bearer ${bob}`, 'x-forwarded-for': '203.0.113.9' },
    })

    expect(
      bobResponse.statusCode,
      'IP-only keying should have thrown Bob out with Alice — if it did not, the ' +
      'test above is not actually observing the keying behaviour',
    ).toBe(429)

    await broken.close()
  })
})
