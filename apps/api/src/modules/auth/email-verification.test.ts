import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma, resetDatabase, createCustomer } from '../../../test/factories.js'
import { buildServer } from '../../http/server.js'
import { FakePaymentProvider } from '../payments/fake-provider.js'
import { ConsoleMailProvider } from '../mail/console-provider.js'
import {
  sendVerificationEmail, verifyEmail, requireVerifiedEmail, purgeExpiredVerifications,
  generateCode, hashCode, CODE_TTL_MS, MAX_ATTEMPTS,
} from './email-verification.js'

const SECRET = 'test-access-secret-at-least-32-characters-long'

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
  await app.settleBackground()
  await resetDatabase()
  mail.reset()
})

/** An account that has NOT verified, which is what a real signup produces. */
async function unverified(email = 'new@example.com') {
  const user = await createCustomer({ email })
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } })
  return user
}

function codeFromEmail(email: string): string {
  const message = mail.lastTo(email)
  if (!message) throw new Error(`No email sent to ${email}`)
  const match = /\b(\d{6})\b/.exec(message.text)
  if (!match?.[1]) throw new Error(`No six-digit code in:\n${message.text}`)
  return match[1]
}

describe('the code itself', () => {
  it('is always six digits, including when it starts with zeros', () => {
    // Dropping the padding would quietly shrink the space by a tenth.
    for (let i = 0; i < 400; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/)
    }
  })

  it('spreads across the whole range rather than clustering', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(generateCode())
    // 500 draws from a million should essentially never repeat.
    expect(seen.size).toBeGreaterThan(495)
  })
})

describe('sending', () => {
  it('mails a code and stores only its hash', async () => {
    const user = await unverified()
    expect(await sendVerificationEmail(prisma, mail, { userId: user.id })).toEqual({ sent: true })

    const code = codeFromEmail('new@example.com')
    const row = await prisma.emailVerification.findFirstOrThrow({ where: { userId: user.id } })
    expect(row.codeHash).not.toBe(code)
    expect(row.codeHash).toBe(hashCode(code))
  })

  it('greets the person by name, unlike the password reset mail', async () => {
    // This one only ever reaches somebody who just typed the address into a
    // signup form, so there is no stranger's inbox to protect.
    await unverified('casey@example.com')
    await sendVerificationEmail(prisma, mail, {
      userId: (await prisma.user.findFirstOrThrow({ where: { email: 'casey@example.com' } })).id,
    })
    expect(mail.lastTo('casey@example.com')!.text).toMatch(/Casey/)
  })

  it('puts the code in the subject, where a phone shows it on the lock screen', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const message = mail.lastTo('new@example.com')!
    expect(message.subject).toMatch(/^\d{6} is your/)
  })

  it('supersedes an outstanding code rather than adding a second live one', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const first = codeFromEmail('new@example.com')

    mail.reset()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const second = codeFromEmail('new@example.com')

    expect(first).not.toBe(second)
    await expect(verifyEmail(prisma, { userId: user.id, code: first }))
      .rejects.toThrow(/not right/i)
    await expect(verifyEmail(prisma, { userId: user.id, code: second }))
      .resolves.toBeTruthy()
  })

  it('does nothing for an account that is already verified', async () => {
    const user = await createCustomer({ email: 'done@example.com' })
    expect(await sendVerificationEmail(prisma, mail, { userId: user.id })).toEqual({ sent: false })
    expect(mail.sent).toHaveLength(0)
  })

  it('does nothing for a deleted account', async () => {
    const user = await unverified()
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } })
    expect(await sendVerificationEmail(prisma, mail, { userId: user.id })).toEqual({ sent: false })
  })
})

describe('entering the code', () => {
  it('verifies with the right code', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const result = await verifyEmail(prisma, {
      userId: user.id, code: codeFromEmail('new@example.com'),
    })

    expect(result.verifiedAt).toBeInstanceOf(Date)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.emailVerifiedAt).not.toBeNull()
  })

  it('works once — a spent code cannot be replayed', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const code = codeFromEmail('new@example.com')

    await verifyEmail(prisma, { userId: user.id, code })
    // Already verified, so this is a no-op rather than an error. The address
    // is verified either way, which is the thing the caller asked about.
    await expect(verifyEmail(prisma, { userId: user.id, code })).resolves.toBeTruthy()

    const rows = await prisma.emailVerification.findMany({ where: { userId: user.id } })
    expect(rows.every((r) => r.consumedAt !== null)).toBe(true)
  })

  it('counts wrong guesses and dies after the ceiling', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const real = codeFromEmail('new@example.com')
    const wrong = real === '000000' ? '111111' : '000000'

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await expect(verifyEmail(prisma, { userId: user.id, code: wrong }))
        .rejects.toThrow(/not right/i)
    }

    // And now even the CORRECT code is refused, because the ceiling is on the
    // code rather than on the guess.
    await expect(verifyEmail(prisma, { userId: user.id, code: real }))
      .rejects.toThrow(/too many wrong tries/i)
  })

  it('tells the person how many tries are left', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const real = codeFromEmail('new@example.com')
    const wrong = real === '000000' ? '111111' : '000000'

    await expect(verifyEmail(prisma, { userId: user.id, code: wrong }))
      .rejects.toThrow(new RegExp(`${MAX_ATTEMPTS - 1} tries left`))
  })

  it('does not let concurrent guesses slip past the ceiling', async () => {
    /*
     * The bug this pins: read attempts, then write attempts+1. Fire the
     * guesses together and they all read 0, so a five-guess ceiling becomes
     * however many requests fit in flight.
     */
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const real = codeFromEmail('new@example.com')
    const wrong = real === '000000' ? '111111' : '000000'

    await Promise.allSettled(
      Array.from({ length: 20 }, () => verifyEmail(prisma, { userId: user.id, code: wrong })),
    )

    const row = await prisma.emailVerification.findFirstOrThrow({ where: { userId: user.id } })
    expect(row.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS)
  })

  it('refuses an expired code and says so, rather than just "wrong"', async () => {
    // Opposite of the password-reset rule, and right for a different reason:
    // the person is verifying their OWN address while authenticated, so there
    // is no third party to keep in the dark.
    const user = await unverified()
    const past = new Date(Date.now() - CODE_TTL_MS - 60_000)
    await sendVerificationEmail(prisma, mail, { userId: user.id, now: past })

    await expect(verifyEmail(prisma, { userId: user.id, code: codeFromEmail('new@example.com') }))
      .rejects.toThrow(/expired/i)
  })

  it('says so when there is no code outstanding at all', async () => {
    const user = await unverified()
    await expect(verifyEmail(prisma, { userId: user.id, code: '123456' }))
      .rejects.toThrow(/not one waiting/i)
  })

  it('refuses a code that proves the OLD inbox after the address changed', async () => {
    /*
     * Otherwise this is a laundering trick: sign up with an address you can
     * read, ask for a code, change to an address you cannot, enter the code,
     * and the unverifiable address is now marked verified.
     */
    const user = await unverified('old@example.com')
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    const code = codeFromEmail('old@example.com')

    await prisma.user.update({ where: { id: user.id }, data: { email: 'new-address@example.com' } })

    await expect(verifyEmail(prisma, { userId: user.id, code }))
      .rejects.toThrow(/address changed/i)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.emailVerifiedAt).toBeNull()
  })

  it('records that it happened', async () => {
    const user = await unverified()
    await sendVerificationEmail(prisma, mail, { userId: user.id })
    await verifyEmail(prisma, { userId: user.id, code: codeFromEmail('new@example.com') })

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'user.email_verified', entityId: user.id },
    })
    expect(entry).not.toBeNull()
  })
})

describe('the gate', () => {
  it('lets a verified account through', async () => {
    const user = await createCustomer({ email: 'ok@example.com' })
    await expect(requireVerifiedEmail(prisma, user.id)).resolves.toBeUndefined()
  })

  it('stops an unverified one', async () => {
    const user = await unverified()
    await expect(requireVerifiedEmail(prisma, user.id)).rejects.toThrow(/verify your email/i)
  })
})

describe('over HTTP', () => {
  async function signUp(email: string) {
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: {
        email, password: 'a-long-enough-password', firstName: 'Riley', intent: 'CUSTOMER',
      },
    })
    expect(response.statusCode).toBe(201)
    // The code is mailed behind the response, so wait for that work.
    await app.settleBackground()
    return JSON.parse(response.body) as { tokens: { accessToken: string } }
  }

  it('mails a code when somebody registers, which never used to happen', async () => {
    await signUp('fresh@example.com')
    expect(mail.lastTo('fresh@example.com')).toBeTruthy()
    expect(codeFromEmail('fresh@example.com')).toMatch(/^\d{6}$/)
  })

  it('registration still succeeds when the mail provider is broken', async () => {
    // The account exists and the person is signed in either way; there is a
    // resend button for exactly this.
    const broken = {
      name: 'broken',
      send: () => Promise.reject(new Error('provider is down')),
    }
    const isolated = await buildServer({
      db: prisma,
      provider: new FakePaymentProvider(),
      mail: broken,
      config: {
        accessSecret: SECRET, accessTtlSeconds: 900, refreshTtlDays: 30,
        ipSalt: 'salt', isProduction: false, rateLimits: { enabled: false },
      },
    })
    await isolated.ready()
    try {
      const response = await isolated.inject({
        method: 'POST', url: '/v1/auth/register',
        payload: {
          email: 'resilient@example.com', password: 'a-long-enough-password',
          firstName: 'Riley', intent: 'CUSTOMER',
        },
      })
      expect(response.statusCode).toBe(201)
      await isolated.settleBackground()
    } finally {
      await isolated.close()
    }
  })

  it('verifies over the wire and then lets the person post', async () => {
    const { tokens } = await signUp('gate@example.com')
    const auth = { authorization: `Bearer ${tokens.accessToken}` }

    // Before: refused, and with a message that says what to do.
    const blocked = await app.inject({
      method: 'POST', url: '/v1/jobs', headers: auth, payload: {},
    })
    expect(blocked.statusCode).toBe(403)
    expect(JSON.parse(blocked.body).error.message).toMatch(/verify your email/i)

    const verified = await app.inject({
      method: 'POST', url: '/v1/auth/verify-email', headers: auth,
      payload: { code: codeFromEmail('gate@example.com') },
    })
    expect(verified.statusCode).toBe(200)

    // After: past the gate. It fails validation now instead, which is the
    // next check along and proves the gate is no longer the thing stopping it.
    const past = await app.inject({
      method: 'POST', url: '/v1/jobs', headers: auth, payload: {},
    })
    expect(past.statusCode).toBe(400)
  })

  it('answers resend the same way whether or not anything was sent', async () => {
    const { tokens } = await signUp('resend@example.com')
    const auth = { authorization: `Bearer ${tokens.accessToken}` }

    const first = await app.inject({
      method: 'POST', url: '/v1/auth/resend-verification', headers: auth,
    })
    await app.settleBackground()

    await app.inject({
      method: 'POST', url: '/v1/auth/verify-email', headers: auth,
      payload: { code: codeFromEmail('resend@example.com') },
    })

    const afterVerified = await app.inject({
      method: 'POST', url: '/v1/auth/resend-verification', headers: auth,
    })
    await app.settleBackground()

    expect(first.statusCode).toBe(202)
    expect(afterVerified.statusCode).toBe(202)
    expect(first.body).toBe(afterVerified.body)
  })

  it('refuses both routes without a token', async () => {
    for (const url of ['/v1/auth/verify-email', '/v1/auth/resend-verification']) {
      const response = await app.inject({ method: 'POST', url, payload: { code: '123456' } })
      expect(response.statusCode).toBe(401)
    }
  })
})

describe('housekeeping', () => {
  it('purges spent and expired rows but keeps a live one', async () => {
    const live = await unverified('live@example.com')
    const dead = await unverified('dead@example.com')

    await sendVerificationEmail(prisma, mail, {
      userId: dead.id, now: new Date(Date.now() - CODE_TTL_MS - 60_000),
    })
    await sendVerificationEmail(prisma, mail, { userId: live.id })

    expect(await prisma.emailVerification.count()).toBe(2)
    expect(await purgeExpiredVerifications(prisma)).toBe(1)
    expect(await prisma.emailVerification.count()).toBe(1)
  })
})
