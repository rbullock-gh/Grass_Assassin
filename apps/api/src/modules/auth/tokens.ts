import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { Db } from '../../lib/prisma.js'
import { UnauthorizedError } from '../../lib/errors.js'

/**
 * Token issuance and rotation.
 *
 * Access tokens are short-lived JWTs verified statelessly. Refresh tokens are
 * opaque random strings — never JWTs — because a refresh token must be
 * revocable, and a stateless token cannot be revoked before it expires.
 *
 * ROTATION WITH REUSE DETECTION
 *
 * Every refresh issues a new refresh token and revokes the one presented. All
 * tokens descended from one login share a `familyId`.
 *
 * If a token that has ALREADY been rotated is presented again, exactly one of
 * two things has happened: a legitimate client retried on a flaky network, or
 * an attacker is replaying a stolen token. We cannot distinguish them, and the
 * safe response to both is the same — revoke the entire family, forcing a fresh
 * login. Without this, a stolen refresh token grants an attacker indefinite
 * access that the real user can never observe or terminate.
 *
 * The raw token is never stored. Only a SHA-256 hash is persisted, so a
 * database leak does not hand over usable credentials.
 */

export interface AccessTokenClaims extends JWTPayload {
  sub: string
  roles: string[]
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/**
 * SHA-256, not argon2, and deliberately so. Refresh tokens are 256 bits of
 * CSPRNG output, not user-chosen secrets — there is no dictionary to attack, so
 * a slow hash buys nothing and would add real latency to every token refresh.
 * Passwords are a different story and use argon2id (see password.ts).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function signAccessToken(params: {
  userId: string
  roles: string[]
  secret: string
  ttlSeconds: number
}): Promise<string> {
  const key = new TextEncoder().encode(params.secret)
  return new SignJWT({ roles: params.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(params.userId)
    .setIssuedAt()
    .setIssuer('grassassassin')
    .setAudience('grassassassin-app')
    .setExpirationTime(`${params.ttlSeconds}s`)
    .sign(key)
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, {
      issuer: 'grassassassin',
      audience: 'grassassassin-app',
    })
    if (typeof payload.sub !== 'string') throw new UnauthorizedError('Malformed token')
    return { ...payload, sub: payload.sub, roles: Array.isArray(payload.roles) ? payload.roles as string[] : [] }
  } catch {
    // Never leak why verification failed — expired, wrong signature, and
    // malformed are all the same answer to a caller.
    throw new UnauthorizedError('Invalid or expired token')
  }
}

export interface IssueSessionParams {
  userId: string
  roles: string[]
  accessSecret: string
  accessTtlSeconds: number
  refreshTtlDays: number
  /** Continuing an existing rotation family, or undefined to start a new one. */
  familyId?: string
  userAgent?: string
  ipHash?: string
}

export async function issueSession(db: Db, params: IssueSessionParams): Promise<TokenPair> {
  const refreshToken = generateRefreshToken()
  const familyId = params.familyId ?? randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + params.refreshTtlDays * 86_400_000)

  await db.refreshToken.create({
    data: {
      userId: params.userId,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt,
      userAgent: params.userAgent ?? null,
      ipHash: params.ipHash ?? null,
    },
  })

  const accessToken = await signAccessToken({
    userId: params.userId,
    roles: params.roles,
    secret: params.accessSecret,
    ttlSeconds: params.accessTtlSeconds,
  })

  return { accessToken, refreshToken, expiresIn: params.accessTtlSeconds }
}

export interface RotateResult {
  tokens: TokenPair
}

/**
 * Exchanges a refresh token for a new pair.
 *
 * Throws UnauthorizedError on anything suspicious, and revokes the family when
 * an already-rotated token is replayed.
 */
export async function rotateSession(db: Db, params: {
  refreshToken: string
  accessSecret: string
  accessTtlSeconds: number
  refreshTtlDays: number
  userAgent?: string
  ipHash?: string
}): Promise<RotateResult> {
  const tokenHash = hashToken(params.refreshToken)

  const existing = await db.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, roles: true, status: true } } },
  })

  if (!existing) throw new UnauthorizedError('Invalid refresh token')

  // REUSE DETECTION. A revoked token being presented means it was already
  // rotated once. Either a client retried or a token was stolen; both are
  // answered by killing the family.
  if (existing.revokedAt !== null) {
    await db.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    throw new UnauthorizedError('Refresh token reuse detected. Please sign in again.')
  }

  if (existing.expiresAt <= new Date()) {
    throw new UnauthorizedError('Refresh token expired')
  }
  if (existing.user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Account is not active')
  }

  const newRefreshToken = generateRefreshToken()
  const newExpiresAt = new Date(Date.now() + params.refreshTtlDays * 86_400_000)

  // Revoke-and-issue in one transaction. A crash between the two would either
  // strand the user with no valid token or leave two live tokens in the family,
  // and the second would trip reuse detection on the next refresh.
  const created = await db.$transaction(async (tx) => {
    const next = await tx.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashToken(newRefreshToken),
        familyId: existing.familyId,
        expiresAt: newExpiresAt,
        userAgent: params.userAgent ?? null,
        ipHash: params.ipHash ?? null,
      },
    })
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedById: next.id },
    })
    return next
  })
  void created

  const accessToken = await signAccessToken({
    userId: existing.userId,
    roles: existing.user.roles,
    secret: params.accessSecret,
    ttlSeconds: params.accessTtlSeconds,
  })

  return {
    tokens: { accessToken, refreshToken: newRefreshToken, expiresIn: params.accessTtlSeconds },
  }
}

/** Signs out one device by revoking a single token. */
export async function revokeSession(db: Db, refreshToken: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Signs out everywhere — used on password change and on admin suspension. */
export async function revokeAllSessions(db: Db, userId: string): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}

/** Housekeeping: expired tokens are dead weight and a needless PII surface. */
export async function purgeExpiredTokens(db: Db, now = new Date()): Promise<number> {
  const result = await db.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } })
  return result.count
}
