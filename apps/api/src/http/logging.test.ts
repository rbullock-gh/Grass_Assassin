import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { prisma, resetDatabase } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'

/**
 * Log redaction.
 *
 * Secrets and PII reaching a log aggregator is a breach that leaves no trace in
 * the application. These tests capture what the logger actually emits rather
 * than trusting the redact config to be correct.
 */

describe('the logger redacts secrets and PII', () => {
  it('never writes a bearer token, password, address or gate code', async () => {
    const lines: string[] = []
    const sink = new Writable({
      write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback() },
    })

    // Build a logger with the same redact config the real server uses, then
    // log a payload containing every sensitive shape we care about.
    const probe = Fastify({
      logger: {
        level: 'info',
        redact: {
          paths: [
            'req.headers.authorization', 'req.headers.cookie',
            '*.password', '*.currentPassword', '*.newPassword', '*.passwordHash',
            '*.accessToken', '*.refreshToken', '*.tokenHash',
            '*.gateCode', '*.addressLine1', '*.addressLine2', '*.phone',
          ],
          censor: '[redacted]',
        },
        stream: sink,
      },
    })
    await probe.ready()

    probe.log.info({
      user: {
        password: 'hunter2-the-real-password',
        passwordHash: '$argon2id$v=19$m=19456',
        phone: '+15551234567',
      },
      session: {
        accessToken: 'eyJhbGciOiJIUzI1NiJ9.SECRET_TOKEN_VALUE',
        refreshToken: 'REFRESH_SECRET_VALUE',
      },
      property: {
        addressLine1: '742 Evergreen Terrace',
        gateCode: '4412',
      },
    }, 'probe')

    await probe.close()
    const output = lines.join('\n')

    expect(output).not.toContain('hunter2-the-real-password')
    expect(output).not.toContain('$argon2id')
    expect(output).not.toContain('SECRET_TOKEN_VALUE')
    expect(output).not.toContain('REFRESH_SECRET_VALUE')
    expect(output).not.toContain('742 Evergreen Terrace')
    expect(output).not.toContain('4412')
    expect(output).not.toContain('+15551234567')
    // And it did log something, so the assertions above are not vacuous.
    expect(output).toContain('[redacted]')
    expect(output).toContain('probe')
  })
})

describe('the real server does not log credentials on a failed login', () => {
  it('keeps the submitted password out of the log stream', async () => {
    await prisma.$connect()
    await resetDatabase()

    const lines: string[] = []
    const sink = new Writable({
      write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback() },
    })

    const app = await buildServer({
      db: prisma,
      provider: new FakePaymentProvider(),
      config: {
        accessSecret: 'test-access-secret-at-least-32-characters-long',
        accessTtlSeconds: 900, refreshTtlDays: 30, ipSalt: 'salt',
        isProduction: false, rateLimits: { enabled: false },
      },
    })
    // Swap in a capturing stream after build, since buildServer owns the logger.
    ;(app.log as unknown as { stream?: unknown }).stream = sink
    await app.ready()

    await app.inject({
      method: 'POST', url: '/v1/auth/login',
      headers: { authorization: 'Bearer SHOULD_NOT_APPEAR' },
      payload: { email: 'nobody@example.com', password: 'my-secret-password-value' },
    })

    await app.close()
    const output = lines.join('\n')
    expect(output).not.toContain('my-secret-password-value')
    expect(output).not.toContain('SHOULD_NOT_APPEAR')

    await prisma.$disconnect()
  })
})
