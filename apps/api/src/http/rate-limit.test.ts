import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma, resetDatabase } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'

/**
 * Rate limiting, tested against its own server instance.
 *
 * The functional HTTP suite runs with limits disabled so that registering
 * thirty test users does not trip the registration limiter. That would be a
 * hole in coverage if left there — so the limiter gets its own file, with
 * limits set deliberately low, and the production defaults are asserted
 * separately.
 */

let app: FastifyInstance

beforeAll(async () => {
  await prisma.$connect()
  await resetDatabase()
  app = await buildServer({
    db: prisma,
    provider: new FakePaymentProvider(),
    config: {
      accessSecret: 'test-access-secret-at-least-32-characters-long',
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      ipSalt: 'test-salt',
      isProduction: false,
      rateLimits: { enabled: true, globalMax: 1000, registerMax: 3, loginMax: 3, claimMax: 5 },
    },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

describe('rate limiting', () => {
  it('throttles repeated registration attempts', async () => {
    const attempt = (i: number) => app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `rl${i}-${Date.now()}@example.com`, password: 'a-long-enough-password', firstName: 'RL' },
    })

    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await attempt(i)).statusCode)

    // The first few succeed, then the limiter engages.
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(3)
    expect(statuses).toContain(429)
  })

  it('returns a structured error body, not a bare 429', async () => {
    const responses: Array<{ statusCode: number; body: string }> = []
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { email: `nobody${i}@example.com`, password: 'whatever-long-enough' },
      })
      responses.push({ statusCode: r.statusCode, body: r.body })
    }

    const limited = responses.find((r) => r.statusCode === 429)
    expect(limited, 'expected the login limiter to engage').toBeDefined()
    const body = JSON.parse(limited!.body)
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(body.error.message).toMatch(/slow down/i)
  })

  it('does not throttle health checks', async () => {
    // A load balancer polling /health must never be rate limited off the
    // instance it is checking.
    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(200)
    }
  })
})

describe('production rate limit defaults', () => {
  it('ships tight limits on the endpoints that matter', async () => {
    const production = await buildServer({
      db: prisma,
      provider: new FakePaymentProvider(),
      config: {
        accessSecret: 'test-access-secret-at-least-32-characters-long',
        accessTtlSeconds: 900, refreshTtlDays: 30, ipSalt: 's', isProduction: true,
      },
    })
    await production.ready()

    // Guards against someone disabling limits by default while chasing a
    // failing test.
    expect(production.rateLimits.enabled).toBe(true)
    expect(production.rateLimits.registerMax).toBeLessThanOrEqual(20)
    expect(production.rateLimits.loginMax).toBeLessThanOrEqual(20)
    expect(production.rateLimits.claimMax).toBeLessThanOrEqual(60)

    await production.close()
  })
})
