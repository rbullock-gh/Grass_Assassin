import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma, resetDatabase, createCustomer } from '../../../test/factories.js'
import { buildServer } from '../../http/server.js'
import { FakePaymentProvider } from '../payments/fake-provider.js'
import { ConsoleMailProvider } from '../mail/console-provider.js'
import {
  requestPasswordReset, resetPassword, hashResetToken, purgeExpiredResetTokens,
  RESET_TOKEN_TTL_MS,
} from './password-reset.js'
import { hashPassword, verifyPassword } from './password.js'
import { issueSession } from './tokens.js'

const SECRET = 'test-access-secret-at-least-32-characters-long'
const PASSWORD = 'correct-horse-battery'

let app: FastifyInstance
const mail = new ConsoleMailProvider(false)

beforeAll(async () => {
  app = await buildServer({
    db: prisma,
    provider: new FakePaymentProvider(),
    mail,
    config: {
      accessSecret: SECRET, accessTtlSeconds: 900, refreshTtlDays: 30,
      ipSalt: 'salt', isProduction: false,
      rateLimits: { enabled: false },
    },
  })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(async () => {
  /*
   * Drain first, then truncate.
   *
   * The forgot-password route replies before doing its work, so a previous
   * test's request can still be writing when this one wipes the tables. That
   * showed up as a foreign key violation logged from a test that had already
   * passed — harmless here, and the same shape as a whole category of test
   * cross-talk that is not harmless at all.
   */
  await app.settleBackground()
  await resetDatabase()
  mail.reset()
})

/** A real account whose password we know. */
async function accountWithPassword(email: string) {
  const user = await createCustomer({ email })
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  })
  return user
}

/** Asks for a reset and digs the token out of the email that was sent. */
async function tokenFromEmail(email: string): Promise<string> {
  const message = mail.lastTo(email)
  if (!message) throw new Error(`No email was sent to ${email}`)
  const match = /token=([A-Za-z0-9_-]+)/.exec(message.text)
  if (!match?.[1]) throw new Error(`No reset token in the email:\n${message.text}`)
  return decodeURIComponent(match[1])
}

describe('asking for a reset', () => {
  it('emails a working link to a real account', async () => {
    const user = await accountWithPassword('real@example.com')
    await requestPasswordReset(prisma, mail, { email: 'real@example.com' })

    expect(mail.sent).toHaveLength(1)
    const token = await tokenFromEmail('real@example.com')

    const stored = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
    })
    expect(stored?.userId).toBe(user.id)
  })

  it('stores only a hash, never the token itself', async () => {
    await accountWithPassword('hash@example.com')
    await requestPasswordReset(prisma, mail, { email: 'hash@example.com' })
    const token = await tokenFromEmail('hash@example.com')

    const rows = await prisma.passwordResetToken.findMany()
    expect(rows).toHaveLength(1)
    // The live token must not be recoverable from a database dump.
    expect(rows[0]!.tokenHash).not.toBe(token)
    expect(rows[0]!.tokenHash).toBe(hashResetToken(token))
  })

  it('sends nothing at all for an address with no account', async () => {
    const outcome = await requestPasswordReset(prisma, mail, { email: 'nobody@example.com' })
    expect(outcome.sent).toBe(false)
    expect(mail.sent).toHaveLength(0)
    expect(await prisma.passwordResetToken.count()).toBe(0)
  })

  it('does not name the person or confirm the account in the email body', async () => {
    // The body may land in the inbox of somebody who never signed up, either
    // through a typo or somebody probing. It must not tell them who is here.
    await accountWithPassword('casey@example.com')
    await requestPasswordReset(prisma, mail, { email: 'casey@example.com' })

    const message = mail.lastTo('casey@example.com')!
    expect(message.text).not.toMatch(/Casey/i)
    expect(message.text).toMatch(/if that was you/i)
  })

  it('kills the previous link when a second one is asked for', async () => {
    await accountWithPassword('twice@example.com')

    await requestPasswordReset(prisma, mail, { email: 'twice@example.com' })
    const first = await tokenFromEmail('twice@example.com')

    mail.reset()
    await requestPasswordReset(prisma, mail, { email: 'twice@example.com' })
    const second = await tokenFromEmail('twice@example.com')

    expect(first).not.toBe(second)
    await expect(resetPassword(prisma, { token: first, newPassword: 'a-new-password-1' }))
      .rejects.toThrow(/not valid/i)
    // The newest one still works.
    await expect(resetPassword(prisma, { token: second, newPassword: 'a-new-password-1' }))
      .resolves.toBeTruthy()
  })

  it('refuses a suspended account without saying so', async () => {
    const user = await accountWithPassword('banned@example.com')
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } })

    const outcome = await requestPasswordReset(prisma, mail, { email: 'banned@example.com' })
    expect(outcome.sent).toBe(false)
    expect(mail.sent).toHaveLength(0)
  })

  it('refuses a deleted account', async () => {
    const user = await accountWithPassword('gone@example.com')
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } })

    await requestPasswordReset(prisma, mail, { email: 'gone@example.com' })
    expect(mail.sent).toHaveLength(0)
  })

  it('matches the address case-insensitively, as people type it', async () => {
    await accountWithPassword('mixed@example.com')
    await requestPasswordReset(prisma, mail, { email: '  MiXeD@Example.COM  ' })
    expect(mail.sent).toHaveLength(1)
  })

  it('never throws, because nobody is awaiting it', async () => {
    // The route fires this without awaiting, so an escaping rejection would be
    // an unhandled rejection rather than a 500. A broken db must not do that.
    const broken = {
      user: { findFirst: () => Promise.reject(new Error('database is on fire')) },
    } as never

    await expect(requestPasswordReset(broken, mail, { email: 'x@example.com' }))
      .resolves.toEqual({ sent: false })
  })
})

describe('spending a reset link', () => {
  it('sets the new password and lets the person sign in with it', async () => {
    await accountWithPassword('works@example.com')
    await requestPasswordReset(prisma, mail, { email: 'works@example.com' })
    const token = await tokenFromEmail('works@example.com')

    await resetPassword(prisma, { token, newPassword: 'brand-new-password' })

    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'works@example.com' } })
    expect(await verifyPassword(after.passwordHash, 'brand-new-password')).toBe(true)
    expect(await verifyPassword(after.passwordHash, PASSWORD)).toBe(false)
  })

  it('works exactly once', async () => {
    await accountWithPassword('once@example.com')
    await requestPasswordReset(prisma, mail, { email: 'once@example.com' })
    const token = await tokenFromEmail('once@example.com')

    await resetPassword(prisma, { token, newPassword: 'first-new-password' })
    await expect(resetPassword(prisma, { token, newPassword: 'second-new-password' }))
      .rejects.toThrow(/not valid/i)
  })

  it('has one loser when the same link is spent twice at the same moment', async () => {
    // The real case: the person and whoever else reads that mailbox, both
    // clicking. Two winners would mean the second quietly overwrites the first.
    await accountWithPassword('race@example.com')
    await requestPasswordReset(prisma, mail, { email: 'race@example.com' })
    const token = await tokenFromEmail('race@example.com')

    const results = await Promise.allSettled([
      resetPassword(prisma, { token, newPassword: 'racer-one-password' }),
      resetPassword(prisma, { token, newPassword: 'racer-two-password' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  })

  it('refuses an expired link', async () => {
    await accountWithPassword('stale@example.com')
    const past = new Date(Date.now() - RESET_TOKEN_TTL_MS - 60_000)
    await requestPasswordReset(prisma, mail, { email: 'stale@example.com', now: past })
    const token = await tokenFromEmail('stale@example.com')

    await expect(resetPassword(prisma, { token, newPassword: 'too-late-password' }))
      .rejects.toThrow(/not valid/i)
  })

  it('refuses a token that was never issued', async () => {
    await expect(resetPassword(prisma, { token: 'made-up', newPassword: 'nice-try-password' }))
      .rejects.toThrow(/not valid/i)
  })

  it('gives the identical message for unknown, expired and spent links', async () => {
    // A link that says "expired" rather than "unknown" tells whoever holds a
    // stolen token which of their guesses was once real.
    await accountWithPassword('same@example.com')
    await requestPasswordReset(prisma, mail, { email: 'same@example.com' })
    const spent = await tokenFromEmail('same@example.com')
    await resetPassword(prisma, { token: spent, newPassword: 'a-fine-password-1' })

    mail.reset()
    const past = new Date(Date.now() - RESET_TOKEN_TTL_MS - 60_000)
    await requestPasswordReset(prisma, mail, { email: 'same@example.com', now: past })
    const expired = await tokenFromEmail('same@example.com')

    const messages: string[] = []
    for (const token of ['never-existed', spent, expired]) {
      await resetPassword(prisma, { token, newPassword: 'another-password-1' })
        .catch((e: Error) => messages.push(e.message))
    }

    expect(messages).toHaveLength(3)
    expect(new Set(messages).size).toBe(1)
  })

  it('signs out every existing session', async () => {
    // The usual reason to reset is that somebody else is in the account.
    const user = await accountWithPassword('sessions@example.com')
    await issueSession(prisma, {
      userId: user.id, roles: ['CUSTOMER'],
      accessSecret: SECRET, accessTtlSeconds: 900, refreshTtlDays: 30,
    })
    await issueSession(prisma, {
      userId: user.id, roles: ['CUSTOMER'],
      accessSecret: SECRET, accessTtlSeconds: 900, refreshTtlDays: 30,
    })
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(2)

    await requestPasswordReset(prisma, mail, { email: 'sessions@example.com' })
    const token = await tokenFromEmail('sessions@example.com')
    const result = await resetPassword(prisma, { token, newPassword: 'kick-them-all-out' })

    expect(result.sessionsRevoked).toBe(2)
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0)
  })

  it('refuses a password below the minimum', async () => {
    await accountWithPassword('weak@example.com')
    await requestPasswordReset(prisma, mail, { email: 'weak@example.com' })
    const token = await tokenFromEmail('weak@example.com')

    await expect(resetPassword(prisma, { token, newPassword: 'short' }))
      .rejects.toThrow(/at least 10/i)

    // And the link survives, so a rejected password does not cost the reset.
    await expect(resetPassword(prisma, { token, newPassword: 'long-enough-now' }))
      .resolves.toBeTruthy()
  })

  it('refuses a link for an account suspended after the link was sent', async () => {
    const user = await accountWithPassword('later@example.com')
    await requestPasswordReset(prisma, mail, { email: 'later@example.com' })
    const token = await tokenFromEmail('later@example.com')

    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } })
    await expect(resetPassword(prisma, { token, newPassword: 'not-coming-back' }))
      .rejects.toThrow(/not valid/i)
  })

  it('records that it happened', async () => {
    const user = await accountWithPassword('audit@example.com')
    await requestPasswordReset(prisma, mail, { email: 'audit@example.com' })
    const token = await tokenFromEmail('audit@example.com')
    await resetPassword(prisma, { token, newPassword: 'audited-password-1' })

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'user.password_reset', entityId: user.id },
    })
    expect(entry).not.toBeNull()
  })
})

describe('over HTTP', () => {
  it('answers 202 identically for a real and an unknown address', async () => {
    await accountWithPassword('http-real@example.com')

    const real = await app.inject({
      method: 'POST', url: '/v1/auth/forgot-password',
      payload: { email: 'http-real@example.com' },
    })
    const unknown = await app.inject({
      method: 'POST', url: '/v1/auth/forgot-password',
      payload: { email: 'http-nobody@example.com' },
    })

    expect(real.statusCode).toBe(202)
    expect(unknown.statusCode).toBe(202)
    // Byte for byte. A difference anywhere in here is an enumeration oracle.
    expect(real.body).toBe(unknown.body)
  })

  it('never returns the token', async () => {
    await accountWithPassword('leak@example.com')
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/forgot-password',
      payload: { email: 'leak@example.com' },
    })
    expect(response.body).not.toMatch(/token/i)
    await app.settleBackground()
  })

  it('completes the whole flow end to end', async () => {
    await accountWithPassword('e2e@example.com')

    const asked = await app.inject({
      method: 'POST', url: '/v1/auth/forgot-password',
      payload: { email: 'e2e@example.com' },
    })
    expect(asked.statusCode).toBe(202)

    /*
     * The route fires the work without awaiting it — that is what keeps the
     * response time from answering the question the body refuses to. So the
     * email has not necessarily been handed over when the response arrives.
     */
    await app.settleBackground()
    const token = await tokenFromEmail('e2e@example.com')

    const reset = await app.inject({
      method: 'POST', url: '/v1/auth/reset-password',
      payload: { token, newPassword: 'the-whole-way-through' },
    })
    expect(reset.statusCode).toBe(204)

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'e2e@example.com', password: 'the-whole-way-through' },
    })
    expect(login.statusCode).toBe(200)
    expect(JSON.parse(login.body).tokens).toBeTruthy()
  })

  it('refuses a bad token with 400 and no detail', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/reset-password',
      payload: { token: 'nope', newPassword: 'long-enough-password' },
    })
    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.body).error.code).toBe('RESET_LINK_INVALID')
  })
})

describe('housekeeping', () => {
  it('purges spent and expired tokens but keeps live ones', async () => {
    await accountWithPassword('live@example.com')
    await accountWithPassword('dead@example.com')

    const past = new Date(Date.now() - RESET_TOKEN_TTL_MS - 60_000)
    await requestPasswordReset(prisma, mail, { email: 'dead@example.com', now: past })
    await requestPasswordReset(prisma, mail, { email: 'live@example.com' })

    expect(await prisma.passwordResetToken.count()).toBe(2)
    expect(await purgeExpiredResetTokens(prisma)).toBe(1)
    expect(await prisma.passwordResetToken.count()).toBe(1)
  })
})
