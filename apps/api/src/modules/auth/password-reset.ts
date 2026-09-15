import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { Db } from '../../lib/prisma.js'
import type { MailProvider } from '../mail/provider.js'
import { hashPassword } from './password.js'
import { revokeAllSessions } from './tokens.js'
import { AppError } from '../../lib/errors.js'

/**
 * Resetting a forgotten password.
 *
 * Before this existed, forgetting your password meant losing the account: there
 * was no recovery path of any kind, and the only other way in — the change
 * password screen — requires the password you have forgotten.
 *
 * The whole design is shaped by one rule that is easy to state and easy to
 * violate by accident: THIS ENDPOINT MUST NOT SAY WHETHER AN ADDRESS HAS AN
 * ACCOUNT. A yard-work marketplace knows where people live. Letting anybody
 * type addresses into a public endpoint and learn which ones are customers is
 * a stalking tool, not a login inconvenience. So:
 *
 *  - the response is identical either way, down to the wording;
 *  - the response does not WAIT for any of this. Looking the address up,
 *    writing a token and handing a message to a mail provider all take
 *    measurably longer than finding nothing, and no amount of care inside this
 *    function makes those two paths the same length. So the route replies 202
 *    before calling it, and this runs behind the response. That is the only
 *    version of the timing argument that actually holds;
 *  - and the email itself is written so that a person who never signed up
 *    learns nothing about who did.
 *
 * Because the route does not await it, this function must never throw. A
 * rejected promise with nobody listening is an unhandled rejection, and in
 * Node that is a process-level event, not a 500.
 */

/** Long enough that guessing is not a strategy: 32 bytes, base64url. */
const TOKEN_BYTES = 32

/**
 * One hour.
 *
 * Long enough for somebody to find the mail on another device, short enough
 * that a link sitting in an inbox read later by somebody else is usually dead.
 * Every session is revoked on use anyway, so a stolen link cannot be used
 * quietly alongside the real person.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

export interface RequestResetParams {
  email: string
  /** Hashed by the caller; this module never sees a raw address. */
  ipHash?: string | undefined
  now?: Date
  /** Where the link points. The app's scheme in production. */
  linkBase?: string
}

/**
 * What happened, for logs and for tests.
 *
 * Deliberately NOT returned to the caller over HTTP — the route has already
 * replied by the time this resolves, which is the point. A test calls this
 * function directly and reads the message out of the console provider.
 */
export interface RequestResetOutcome {
  /** False when the address has no active account. Never leaves the server. */
  sent: boolean
}

export async function requestPasswordReset(
  db: Db,
  mail: MailProvider,
  params: RequestResetParams,
): Promise<RequestResetOutcome> {
  try {
    return await attemptPasswordReset(db, mail, params)
  } catch (caught) {
    // Nothing is awaiting this. An escaping rejection is an unhandled
    // rejection, which in Node is a process-level event and not a 500.
    console.error('[password-reset] request failed:', (caught as Error).message)
    return { sent: false }
  }
}

async function attemptPasswordReset(
  db: Db,
  mail: MailProvider,
  params: RequestResetParams,
): Promise<RequestResetOutcome> {
  const now = params.now ?? new Date()
  const email = params.email.trim().toLowerCase()

  const user = await db.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, firstName: true, status: true },
  })

  const token = generateResetToken()
  const tokenHash = hashResetToken(token)

  /*
   * A banned account gets no reset. It is not told so here — that would answer
   * the question this endpoint refuses to answer — and the person finds out at
   * sign-in, where the suspension message belongs.
   */
  const eligible = user !== null && user.status === 'ACTIVE'

  if (eligible && user) {
    await db.$transaction(async (tx) => {
      /*
       * Outstanding tokens for this person are spent, not left alongside the
       * new one. Otherwise asking twice because the first mail was slow leaves
       * two live links, and the older one — the one more likely to have been
       * forwarded, logged by a mail scanner, or read on a shared machine —
       * stays valid.
       */
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      })

      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
          requestIpHash: params.ipHash ?? null,
        },
      })
    })
  }

  const message = buildResetEmail({
    to: email,
    firstName: eligible && user ? user.firstName : null,
    token,
    linkBase: params.linkBase ?? 'grassassassin://reset-password',
    expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000),
  })

  if (!eligible) return { sent: false }

  await mail.send(message).catch((caught: unknown) => {
    /*
     * Swallowed on purpose, and logged without the address.
     *
     * Nobody is waiting on this promise — the response went out before it
     * started — so rethrowing would produce an unhandled rejection and tell no
     * one anything. A provider outage is an operational problem, visible in
     * logs and in the provider's own dashboard, not something to surface to
     * whoever typed an address into a public form.
     */
    console.error('[password-reset] delivery failed:', (caught as Error).message)
  })

  return { sent: true }
}

interface ResetEmailParams {
  to: string
  firstName: string | null
  token: string
  linkBase: string
  expiresInMinutes: number
}

/**
 * The email.
 *
 * Addressed to no name and describing no account, because it may land in the
 * inbox of somebody who never signed up — either a typo or somebody probing.
 * "Hi Casey, here is your GrassAssassin reset" tells that person that Casey has
 * an account at this address. "Somebody asked to reset the password for this
 * address" tells them nothing they did not already supply.
 */
function buildResetEmail(params: ResetEmailParams) {
  const link = `${params.linkBase}?token=${encodeURIComponent(params.token)}`

  const text = [
    'Somebody asked to reset the password for the GrassAssassin account at this address.',
    '',
    'If that was you, open this link to choose a new one:',
    link,
    '',
    `The link stops working in ${params.expiresInMinutes} minutes, and works only once.`,
    '',
    'If it was not you, you do not need to do anything. Nothing has changed, and',
    'nobody can see this message but you.',
  ].join('\n')

  return {
    to: params.to,
    subject: 'Reset your GrassAssassin password',
    text,
    category: 'password-reset' as const,
  }
}

export interface ResetPasswordParams {
  token: string
  newPassword: string
  now?: Date
}

export interface ResetPasswordResult {
  userId: string
  /** Sessions killed. Shown to nobody; recorded so the audit row is specific. */
  sessionsRevoked: number
}

/**
 * Spends a token and sets the new password.
 *
 * Every failure gives the same message. A reset link that says "this link has
 * expired" versus "no such link" tells somebody holding a stolen token which
 * of their guesses was once real.
 */
export async function resetPassword(
  db: Db,
  params: ResetPasswordParams,
): Promise<ResetPasswordResult> {
  const now = params.now ?? new Date()
  const refuse = () => new AppError(
    'RESET_LINK_INVALID',
    'That reset link is not valid any more. Ask for a new one.',
    400,
  )

  if (params.newPassword.length < 10) {
    throw new AppError('WEAK_PASSWORD', 'Password must be at least 10 characters', 400)
  }

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(params.token) },
    select: {
      id: true, userId: true, expiresAt: true, usedAt: true, tokenHash: true,
      user: { select: { id: true, status: true, deletedAt: true } },
    },
  })

  if (!record) throw refuse()

  /*
   * The lookup above is by unique index on a SHA-256 digest, so this comparison
   * can only ever succeed. It is here because the day somebody changes that
   * lookup to a scan — over a prefix, or a `findFirst` with a range — the
   * comparison that replaces the index becomes attacker-timed, and this is the
   * one that does not leak. Cheap insurance against a plausible future edit.
   */
  const presented = Buffer.from(hashResetToken(params.token))
  const stored = Buffer.from(record.tokenHash)
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) throw refuse()

  if (record.usedAt !== null) throw refuse()
  if (record.expiresAt <= now) throw refuse()
  if (record.user.deletedAt !== null) throw refuse()
  if (record.user.status !== 'ACTIVE') throw refuse()

  const passwordHash = await hashPassword(params.newPassword)

  /*
   * Spending the token and setting the password happen together, and the spend
   * is conditional on it still being unspent. Two people holding the same link
   * — the real person and whoever else has the mailbox — must not both get a
   * reset, and `usedAt: null` in the WHERE is what makes the race have a loser
   * rather than two winners.
   */
  const spent = await db.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    })
    if (claimed.count === 0) return false

    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    })

    // Any other outstanding link dies with this one.
    await tx.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: now },
    })

    await tx.auditLog.create({
      data: {
        actorId: record.userId,
        actorType: 'USER',
        action: 'user.password_reset',
        entityType: 'User',
        entityId: record.userId,
        after: { at: now.toISOString() },
      },
    })

    return true
  })

  if (!spent) throw refuse()

  /*
   * Every session goes.
   *
   * The common reason to reset a password is that somebody else has been in the
   * account. Leaving their refresh token alive would make the reset a gesture.
   */
  const sessionsRevoked = await revokeAllSessions(db, record.userId)

  return { userId: record.userId, sessionsRevoked }
}

/** Housekeeping: spent and expired tokens are not worth keeping. */
export async function purgeExpiredResetTokens(db: Db, now = new Date()): Promise<number> {
  const result = await db.passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
  })
  return result.count
}
