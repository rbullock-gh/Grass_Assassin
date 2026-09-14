import type { Db } from '../../lib/prisma.js'
import { ConflictError, UnauthorizedError, ForbiddenError } from '../../lib/errors.js'
import { hashPassword, verifyPassword, getDummyHash } from './password.js'
import { issueSession, revokeAllSessions, type TokenPair } from './tokens.js'

/**
 * Registration and login.
 *
 * Both paths are written so that an attacker learns nothing about which email
 * addresses have accounts — see the timing note in password.ts and the uniform
 * error message below.
 */

export interface AuthConfig {
  accessSecret: string
  accessTtlSeconds: number
  refreshTtlDays: number
}

export interface RegisterParams {
  email: string
  password: string
  firstName: string
  lastName?: string
  phone?: string
  intent: 'CUSTOMER' | 'WORKER'
  userAgent?: string
  ipHash?: string
}

export interface AuthenticatedUser {
  id: string
  email: string
  firstName: string
  roles: string[]
}

export interface AuthResult {
  user: AuthenticatedUser
  tokens: TokenPair
}

/** Emails are stored lowercased and trimmed so uniqueness is meaningful. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function register(db: Db, config: AuthConfig, params: RegisterParams): Promise<AuthResult> {
  const email = normalizeEmail(params.email)

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) {
    // Registration is the one place we cannot fully hide account existence —
    // the address is either available or it is not. Rate limiting on this
    // endpoint is what actually contains enumeration here.
    throw new ConflictError('EMAIL_TAKEN', 'An account with that email already exists')
  }

  const passwordHash = await hashPassword(params.password)

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        passwordHash,
        firstName: params.firstName.trim(),
        lastName: params.lastName?.trim() ?? null,
        phone: params.phone ?? null,
        roles: [params.intent],
      },
      select: { id: true, email: true, firstName: true, roles: true },
    })

    // Both profiles are cheap and a user can switch sides later, so create the
    // one they signed up for now and let the other be created on demand.
    if (params.intent === 'CUSTOMER') {
      await tx.customerProfile.create({ data: { userId: created.id } })
    } else {
      await tx.workerProfile.create({ data: { userId: created.id, status: 'PENDING_ONBOARDING' } })
    }

    await tx.auditLog.create({
      data: {
        actorId: created.id, actorType: 'USER', action: 'user.register',
        entityType: 'User', entityId: created.id,
        after: { email, intent: params.intent },
        ipHash: params.ipHash ?? null, userAgent: params.userAgent ?? null,
      },
    })

    return created
  })

  const tokens = await issueSession(db, {
    userId: user.id,
    roles: user.roles,
    accessSecret: config.accessSecret,
    accessTtlSeconds: config.accessTtlSeconds,
    refreshTtlDays: config.refreshTtlDays,
    userAgent: params.userAgent,
    ipHash: params.ipHash,
  })

  return { user, tokens }
}

export async function login(db: Db, config: AuthConfig, params: {
  email: string
  password: string
  userAgent?: string
  ipHash?: string
}): Promise<AuthResult> {
  const email = normalizeEmail(params.email)
  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true, email: true, firstName: true, roles: true,
      passwordHash: true, status: true, suspendedUntil: true, deletedAt: true,
    },
  })

  // Verify against a dummy hash when the user does not exist, so both branches
  // take the same ~50ms. Returning early here would make account enumeration
  // trivial with a stopwatch.
  const hash = user?.passwordHash ?? (await getDummyHash())
  const passwordOk = await verifyPassword(hash, params.password)

  if (!user || !passwordOk || user.deletedAt !== null) {
    throw new UnauthorizedError('Incorrect email or password')
  }

  if (user.status === 'BANNED') {
    throw new ForbiddenError('This account has been permanently closed. Contact support.')
  }
  if (user.status === 'SUSPENDED') {
    const until = user.suspendedUntil
    if (!until || until > new Date()) {
      throw new ForbiddenError('This account is suspended. Contact support.')
    }
    // The suspension has lapsed — restore the account rather than making the
    // user contact support to undo something that already expired.
    await db.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', suspendedUntil: null, suspensionReason: null },
    })
  }

  await db.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } })

  const tokens = await issueSession(db, {
    userId: user.id,
    roles: user.roles,
    accessSecret: config.accessSecret,
    accessTtlSeconds: config.accessTtlSeconds,
    refreshTtlDays: config.refreshTtlDays,
    userAgent: params.userAgent,
    ipHash: params.ipHash,
  })

  return {
    user: { id: user.id, email: user.email, firstName: user.firstName, roles: user.roles },
    tokens,
  }
}

/**
 * Changing a password signs out every other device.
 *
 * If the password was changed because it was compromised, leaving other
 * sessions alive defeats the entire point of changing it.
 */
export async function changePassword(db: Db, params: {
  userId: string
  currentPassword: string
  newPassword: string
}): Promise<void> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: { passwordHash: true },
  })

  if (!(await verifyPassword(user.passwordHash, params.currentPassword))) {
    throw new UnauthorizedError('Current password is incorrect')
  }

  const passwordHash = await hashPassword(params.newPassword)
  await db.user.update({ where: { id: params.userId }, data: { passwordHash } })
  await revokeAllSessions(db, params.userId)
  await db.auditLog.create({
    data: {
      actorId: params.userId, actorType: 'USER', action: 'user.password_changed',
      entityType: 'User', entityId: params.userId,
    },
  })
}

/**
 * Adds the second marketplace role to an existing account.
 *
 * A worker who wants their own lawn mowed, or a customer who decides to start
 * earning, should not need a second account with a second email.
 */
export async function addRole(db: Db, userId: string, role: 'CUSTOMER' | 'WORKER'): Promise<string[]> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { roles: true },
  })
  if (user.roles.includes(role)) return user.roles

  const updated = await db.$transaction(async (tx) => {
    const next = await tx.user.update({
      where: { id: userId },
      data: { roles: { push: role } },
      select: { roles: true },
    })
    if (role === 'CUSTOMER') {
      await tx.customerProfile.upsert({ where: { userId }, create: { userId }, update: {} })
    } else {
      await tx.workerProfile.upsert({
        where: { userId },
        create: { userId, status: 'PENDING_ONBOARDING' },
        update: {},
      })
    }
    return next
  })

  return updated.roles
}
