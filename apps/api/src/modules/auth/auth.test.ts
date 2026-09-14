import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma, resetDatabase, createCustomer } from '../../../test/factories.js'
import { register, login, changePassword, addRole, normalizeEmail, type AuthConfig } from './service.js'
import {
  issueSession, rotateSession, revokeSession, revokeAllSessions,
  verifyAccessToken, signAccessToken, hashToken, generateRefreshToken, purgeExpiredTokens,
} from './tokens.js'
import { hashPassword, verifyPassword } from './password.js'
import { UnauthorizedError, ConflictError, ForbiddenError } from '../../lib/errors.js'

const config: AuthConfig = {
  accessSecret: 'test-access-secret-at-least-32-characters-long',
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
}

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => { await resetDatabase() })

describe('password hashing', () => {
  it('produces a verifiable argon2id hash', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(hash, 'wrong password entirely')).toBe(false)
  })

  it('salts, so identical passwords hash differently', async () => {
    const a = await hashPassword('same-password-here')
    const b = await hashPassword('same-password-here')
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'same-password-here')).toBe(true)
    expect(await verifyPassword(b, 'same-password-here')).toBe(true)
  })

  it('treats a corrupted stored hash as a wrong password, not a crash', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'anything')).toBe(false)
  })
})

describe('registration', () => {
  it('creates a customer with a profile and returns a usable session', async () => {
    const result = await register(prisma, config, {
      email: 'Casey@Example.COM ', password: 'a-long-enough-password',
      firstName: 'Casey', intent: 'CUSTOMER',
    })

    expect(result.user.email).toBe('casey@example.com')
    expect(result.user.roles).toEqual(['CUSTOMER'])
    expect(result.tokens.accessToken).toBeTruthy()
    expect(result.tokens.refreshToken).toBeTruthy()

    const claims = await verifyAccessToken(result.tokens.accessToken, config.accessSecret)
    expect(claims.sub).toBe(result.user.id)

    expect(await prisma.customerProfile.findUnique({ where: { userId: result.user.id } })).not.toBeNull()
    expect(await prisma.workerProfile.findUnique({ where: { userId: result.user.id } })).toBeNull()
  })

  it('creates a worker in PENDING_ONBOARDING, not approved', async () => {
    const result = await register(prisma, config, {
      email: 'riley@example.com', password: 'a-long-enough-password',
      firstName: 'Riley', intent: 'WORKER',
    })
    const profile = await prisma.workerProfile.findUniqueOrThrow({ where: { userId: result.user.id } })
    expect(profile.status).toBe('PENDING_ONBOARDING')
    // A self-registered worker must never start able to claim jobs.
    expect(profile.payoutsEnabled).toBe(false)
  })

  it('never stores the password in plaintext', async () => {
    const result = await register(prisma, config, {
      email: 'x@example.com', password: 'super-secret-value', firstName: 'X', intent: 'CUSTOMER',
    })
    const row = await prisma.user.findUniqueOrThrow({ where: { id: result.user.id } })
    expect(row.passwordHash).not.toContain('super-secret-value')
    expect(row.passwordHash).toMatch(/^\$argon2id\$/)
  })

  it('rejects a duplicate email regardless of casing', async () => {
    await register(prisma, config, {
      email: 'dupe@example.com', password: 'a-long-enough-password', firstName: 'A', intent: 'CUSTOMER',
    })
    await expect(register(prisma, config, {
      email: 'DUPE@Example.com', password: 'a-long-enough-password', firstName: 'B', intent: 'CUSTOMER',
    })).rejects.toThrow(ConflictError)
  })

  it('writes an audit log entry', async () => {
    const result = await register(prisma, config, {
      email: 'audited@example.com', password: 'a-long-enough-password', firstName: 'A', intent: 'CUSTOMER',
    })
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: result.user.id } })
    expect(log.action).toBe('user.register')
    // The password must not appear anywhere in the audit trail.
    expect(JSON.stringify(log.after)).not.toContain('a-long-enough-password')
  })

  it('normalizes emails consistently', () => {
    expect(normalizeEmail('  MiXeD@Case.COM  ')).toBe('mixed@case.com')
  })
})

describe('login', () => {
  beforeEach(async () => {
    await register(prisma, config, {
      email: 'user@example.com', password: 'the-right-password', firstName: 'User', intent: 'CUSTOMER',
    })
  })

  it('accepts correct credentials', async () => {
    const result = await login(prisma, config, { email: 'user@example.com', password: 'the-right-password' })
    expect(result.user.email).toBe('user@example.com')
    expect(result.tokens.accessToken).toBeTruthy()
  })

  it('rejects a wrong password', async () => {
    await expect(login(prisma, config, { email: 'user@example.com', password: 'wrong' }))
      .rejects.toThrow(UnauthorizedError)
  })

  it('gives an identical error for unknown and wrong-password, so accounts cannot be enumerated', async () => {
    const unknown = await login(prisma, config, { email: 'nobody@example.com', password: 'x' })
      .catch((e: Error) => e.message)
    const wrong = await login(prisma, config, { email: 'user@example.com', password: 'x' })
      .catch((e: Error) => e.message)
    expect(unknown).toBe(wrong)
    expect(unknown).toBe('Incorrect email or password')
  })

  it('refuses a banned account', async () => {
    await prisma.user.update({ where: { email: 'user@example.com' }, data: { status: 'BANNED' } })
    await expect(login(prisma, config, { email: 'user@example.com', password: 'the-right-password' }))
      .rejects.toThrow(ForbiddenError)
  })

  it('refuses a currently suspended account', async () => {
    await prisma.user.update({
      where: { email: 'user@example.com' },
      data: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() + 86_400_000) },
    })
    await expect(login(prisma, config, { email: 'user@example.com', password: 'the-right-password' }))
      .rejects.toThrow(ForbiddenError)
  })

  it('restores an account whose suspension has lapsed instead of making them contact support', async () => {
    await prisma.user.update({
      where: { email: 'user@example.com' },
      data: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() - 1000) },
    })
    const result = await login(prisma, config, { email: 'user@example.com', password: 'the-right-password' })
    expect(result.user.id).toBeTruthy()
    const after = await prisma.user.findUniqueOrThrow({ where: { email: 'user@example.com' } })
    expect(after.status).toBe('ACTIVE')
    expect(after.suspendedUntil).toBeNull()
  })

  it('refuses a soft-deleted account', async () => {
    await prisma.user.update({ where: { email: 'user@example.com' }, data: { deletedAt: new Date() } })
    await expect(login(prisma, config, { email: 'user@example.com', password: 'the-right-password' }))
      .rejects.toThrow(UnauthorizedError)
  })
})

describe('access tokens', () => {
  it('round-trips claims', async () => {
    const token = await signAccessToken({
      userId: 'user-1', roles: ['WORKER'], secret: config.accessSecret, ttlSeconds: 900,
    })
    const claims = await verifyAccessToken(token, config.accessSecret)
    expect(claims.sub).toBe('user-1')
    expect(claims.roles).toEqual(['WORKER'])
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken({
      userId: 'user-1', roles: [], secret: 'another-secret-at-least-32-characters-long', ttlSeconds: 900,
    })
    await expect(verifyAccessToken(token, config.accessSecret)).rejects.toThrow(UnauthorizedError)
  })

  it('rejects an expired token', async () => {
    const token = await signAccessToken({
      userId: 'user-1', roles: [], secret: config.accessSecret, ttlSeconds: -10,
    })
    await expect(verifyAccessToken(token, config.accessSecret)).rejects.toThrow(UnauthorizedError)
  })

  it('rejects a tampered token', async () => {
    const token = await signAccessToken({
      userId: 'user-1', roles: ['CUSTOMER'], secret: config.accessSecret, ttlSeconds: 900,
    })
    const [header, , signature] = token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({
      sub: 'user-1', roles: ['ADMIN'], iss: 'grassassassin', aud: 'grassassassin-app',
      exp: Math.floor(Date.now() / 1000) + 900,
    })).toString('base64url')
    await expect(verifyAccessToken(`${header}.${forgedPayload}.${signature}`, config.accessSecret))
      .rejects.toThrow(UnauthorizedError)
  })

  it('gives the same message for every failure mode, leaking nothing', async () => {
    const expired = await signAccessToken({ userId: 'u', roles: [], secret: config.accessSecret, ttlSeconds: -1 })
    const wrongKey = await signAccessToken({ userId: 'u', roles: [], secret: 'x'.repeat(40), ttlSeconds: 900 })
    const a = await verifyAccessToken(expired, config.accessSecret).catch((e: Error) => e.message)
    const b = await verifyAccessToken(wrongKey, config.accessSecret).catch((e: Error) => e.message)
    const c = await verifyAccessToken('garbage', config.accessSecret).catch((e: Error) => e.message)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('refresh token rotation', () => {
  let userId: string

  beforeEach(async () => {
    const user = await createCustomer({ email: 'rotate@example.com' })
    userId = user.id
  })

  const issue = () => issueSession(prisma, {
    userId, roles: ['CUSTOMER'], accessSecret: config.accessSecret,
    accessTtlSeconds: 900, refreshTtlDays: 30,
  })

  const rotate = (refreshToken: string) => rotateSession(prisma, {
    refreshToken, accessSecret: config.accessSecret,
    accessTtlSeconds: 900, refreshTtlDays: 30,
  })

  it('never stores the raw refresh token', async () => {
    const tokens = await issue()
    const rows = await prisma.refreshToken.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).not.toBe(tokens.refreshToken)
    expect(rows[0]!.tokenHash).toBe(hashToken(tokens.refreshToken))
  })

  it('issues a new pair and revokes the old token', async () => {
    const first = await issue()
    const result = await rotate(first.refreshToken)

    expect(result.tokens.refreshToken).not.toBe(first.refreshToken)

    const oldRow = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(first.refreshToken) },
    })
    expect(oldRow.revokedAt).not.toBeNull()
    expect(oldRow.replacedById).not.toBeNull()
  })

  it('keeps rotations in one family', async () => {
    const a = await issue()
    const b = await rotate(a.refreshToken)
    const c = await rotate(b.tokens.refreshToken)

    const rows = await prisma.refreshToken.findMany()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(1)
    expect(c.tokens.refreshToken).toBeTruthy()
  })

  it('DETECTS REUSE and revokes the entire family', async () => {
    // The scenario that matters: a token is stolen, the real user refreshes
    // normally, and then the attacker replays the token they captured.
    const first = await issue()
    const second = await rotate(first.refreshToken)
    await rotate(second.tokens.refreshToken)

    // Attacker replays the original, already-rotated token.
    await expect(rotate(first.refreshToken)).rejects.toThrow(/reuse detected/i)

    // Every token in the family is now dead, including the legitimate user's
    // current one. They must sign in again — which is the point: the theft
    // becomes visible and bounded instead of silent and indefinite.
    const live = await prisma.refreshToken.count({ where: { userId, revokedAt: null } })
    expect(live).toBe(0)
  })

  it('locks out the attacker\'s freshly minted token too', async () => {
    const first = await issue()
    const stolen = await rotate(first.refreshToken)
    await rotate(first.refreshToken).catch(() => undefined) // triggers family revocation

    await expect(rotate(stolen.tokens.refreshToken)).rejects.toThrow(UnauthorizedError)
  })

  it('does not touch a different login family', async () => {
    // A phone and a laptop are separate families; compromising one must not
    // sign the user out of the other.
    const phone = await issue()
    const laptop = await issue()

    await rotate(phone.refreshToken)
    await rotate(phone.refreshToken).catch(() => undefined) // revokes the phone family

    const stillGood = await rotate(laptop.refreshToken)
    expect(stillGood.tokens.accessToken).toBeTruthy()
  })

  it('rejects an unknown refresh token', async () => {
    await expect(rotate(generateRefreshToken())).rejects.toThrow(UnauthorizedError)
  })

  it('rejects an expired refresh token', async () => {
    const tokens = await issue()
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(tokens.refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(rotate(tokens.refreshToken)).rejects.toThrow(/expired/i)
  })

  it('rejects rotation for a suspended account', async () => {
    const tokens = await issue()
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } })
    await expect(rotate(tokens.refreshToken)).rejects.toThrow(/not active/i)
  })

  it('revokes a single session on sign-out without affecting others', async () => {
    const phone = await issue()
    const laptop = await issue()

    await revokeSession(prisma, phone.refreshToken)

    await expect(rotate(phone.refreshToken)).rejects.toThrow(UnauthorizedError)
    expect((await rotate(laptop.refreshToken)).tokens.accessToken).toBeTruthy()
  })

  it('revokes everything on sign-out-everywhere', async () => {
    await issue(); await issue(); await issue()
    expect(await revokeAllSessions(prisma, userId)).toBe(3)
    expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(0)
  })

  it('purges expired tokens without touching live ones', async () => {
    const live = await issue()
    const dead = await issue()
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(dead.refreshToken) },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    })

    expect(await purgeExpiredTokens(prisma)).toBe(1)
    expect(await prisma.refreshToken.count()).toBe(1)
    expect((await rotate(live.refreshToken)).tokens.accessToken).toBeTruthy()
  })
})

describe('password change', () => {
  it('signs out every other device', async () => {
    const result = await register(prisma, config, {
      email: 'changer@example.com', password: 'original-password-x', firstName: 'C', intent: 'CUSTOMER',
    })
    await issueSession(prisma, {
      userId: result.user.id, roles: ['CUSTOMER'], accessSecret: config.accessSecret,
      accessTtlSeconds: 900, refreshTtlDays: 30,
    })
    expect(await prisma.refreshToken.count({ where: { userId: result.user.id, revokedAt: null } })).toBe(2)

    await changePassword(prisma, {
      userId: result.user.id, currentPassword: 'original-password-x', newPassword: 'a-brand-new-password',
    })

    // If the password was changed because it leaked, leaving sessions alive
    // defeats the entire point.
    expect(await prisma.refreshToken.count({ where: { userId: result.user.id, revokedAt: null } })).toBe(0)
    await expect(login(prisma, config, { email: 'changer@example.com', password: 'a-brand-new-password' }))
      .resolves.toBeTruthy()
    await expect(login(prisma, config, { email: 'changer@example.com', password: 'original-password-x' }))
      .rejects.toThrow(UnauthorizedError)
  })

  it('refuses when the current password is wrong', async () => {
    const result = await register(prisma, config, {
      email: 'nochange@example.com', password: 'original-password-x', firstName: 'C', intent: 'CUSTOMER',
    })
    await expect(changePassword(prisma, {
      userId: result.user.id, currentPassword: 'not-it', newPassword: 'a-brand-new-password',
    })).rejects.toThrow(UnauthorizedError)
  })
})

describe('dual-role accounts', () => {
  it('lets a customer become a worker on the same account', async () => {
    const result = await register(prisma, config, {
      email: 'dual@example.com', password: 'a-long-enough-password', firstName: 'D', intent: 'CUSTOMER',
    })

    const roles = await addRole(prisma, result.user.id, 'WORKER')

    expect(roles.sort()).toEqual(['CUSTOMER', 'WORKER'])
    expect(await prisma.workerProfile.findUnique({ where: { userId: result.user.id } })).not.toBeNull()
    expect(await prisma.customerProfile.findUnique({ where: { userId: result.user.id } })).not.toBeNull()
  })

  it('is idempotent', async () => {
    const result = await register(prisma, config, {
      email: 'idem@example.com', password: 'a-long-enough-password', firstName: 'D', intent: 'WORKER',
    })
    await addRole(prisma, result.user.id, 'WORKER')
    const roles = await addRole(prisma, result.user.id, 'WORKER')
    expect(roles).toEqual(['WORKER'])
  })
})
