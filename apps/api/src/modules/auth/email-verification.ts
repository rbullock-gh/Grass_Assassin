import { randomInt, createHash, timingSafeEqual } from 'node:crypto'
import type { Db } from '../../lib/prisma.js'
import type { MailProvider } from '../mail/provider.js'
import { AppError, ForbiddenError } from '../../lib/errors.js'

/**
 * Proving somebody can read the address they signed up with.
 *
 * Before this, `emailVerifiedAt` was written by the seed script and the test
 * factories and by nothing else. Every real account had it null forever, `/me`
 * dutifully returned that null, and no part of the product looked at it. The
 * column was decoration.
 *
 * It matters here more than it does in most products. This marketplace sends
 * strangers to people's homes and it bans the ones who behave badly — a ban
 * that a free throwaway address undoes in thirty seconds is not a ban. The
 * enforcement built elsewhere in this system assumes an account costs
 * something to replace, and until now one did not.
 *
 * A SIX DIGIT CODE, NOT A LINK. The person is holding the phone with the app
 * open — that is the one moment when a code typed in beats a link that makes
 * them leave, switch app, come back and hope the session survived. Six digits
 * is only a million possibilities, so the protection is not the code: it is
 * the attempt ceiling below, plus the rate limit on the route.
 */

/** Thirty minutes. Long enough to find the mail, short enough to be worth little. */
export const CODE_TTL_MS = 30 * 60 * 1000

/**
 * Five wrong guesses and the code is dead.
 *
 * Six digits with unlimited guesses is a formality. Five leaves a one-in-
 * two-hundred-thousand chance per code, and burning a code is cheap for the
 * real person — they press resend — and expensive for a script, which has to
 * trigger a new email for every five attempts and meet the send rate limit.
 */
export const MAX_ATTEMPTS = 5

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * Six digits, uniformly.
 *
 * `randomInt` rather than `Math.random()`, and a range rather than six
 * independent digits, because both of the obvious shortcuts bias the result.
 * Leading zeros are kept — "004321" is a valid code and dropping the padding
 * would quietly shrink the space by a tenth.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export interface SendVerificationResult {
  /** False when there was nothing to do — already verified. */
  sent: boolean
}

/**
 * Issues a code and mails it.
 *
 * Safe to call again: an outstanding code is superseded rather than joined, so
 * pressing resend twice does not leave two live codes, the older of which is
 * the one more likely to have been read by somebody else.
 */
export async function sendVerificationEmail(
  db: Db,
  mail: MailProvider,
  params: { userId: string; now?: Date },
): Promise<SendVerificationResult> {
  const now = params.now ?? new Date()

  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, firstName: true, emailVerifiedAt: true, deletedAt: true },
  })

  if (!user || user.deletedAt !== null) return { sent: false }
  if (user.emailVerifiedAt !== null) return { sent: false }

  const code = generateCode()

  await db.$transaction(async (tx) => {
    await tx.emailVerification.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: now },
    })
    await tx.emailVerification.create({
      data: {
        userId: user.id,
        email: user.email,
        codeHash: hashCode(code),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
    })
  })

  /*
   * Unlike the password-reset mail, this one CAN greet the person by name and
   * say which account it is for. It only ever goes to somebody who just typed
   * this address into a signup form while holding the phone, so there is no
   * stranger's inbox to protect and nothing here they did not just supply.
   */
  await mail.send({
    to: user.email,
    subject: `${code} is your GrassAssassin code`,
    text: [
      `Hi ${user.firstName},`,
      '',
      'Your GrassAssassin verification code is:',
      '',
      `    ${code}`,
      '',
      `It expires in ${Math.round(CODE_TTL_MS / 60000)} minutes.`,
      '',
      'If you did not sign up for GrassAssassin, you can ignore this — the',
      'account cannot do anything until somebody enters this code.',
    ].join('\n'),
    category: 'account',
  })

  return { sent: true }
}

export interface VerifyResult {
  verifiedAt: Date
}

/**
 * Spends a code.
 *
 * Failure messages distinguish "wrong" from "expired" on purpose, which is the
 * opposite of the password-reset rule and is right for a different reason:
 * here the person is already authenticated and verifying their OWN address, so
 * there is no third party to keep in the dark, and "that code has expired,
 * here is a new one" is the difference between a person getting in and a person
 * typing the same dead code four times.
 */
export async function verifyEmail(
  db: Db,
  params: { userId: string; code: string; now?: Date },
): Promise<VerifyResult> {
  const now = params.now ?? new Date()

  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: { id: true, email: true, emailVerifiedAt: true },
  })
  if (!user) throw new ForbiddenError('No such account')
  if (user.emailVerifiedAt) return { verifiedAt: user.emailVerifiedAt }

  const record = await db.emailVerification.findFirst({
    where: { userId: params.userId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, codeHash: true, expiresAt: true, attempts: true, email: true },
  })

  if (!record) {
    throw new AppError(
      'NO_CODE_OUTSTANDING',
      'Ask for a new code — there is not one waiting.',
      400,
    )
  }

  if (record.expiresAt <= now) {
    throw new AppError('CODE_EXPIRED', 'That code has expired. Ask for a new one.', 400)
  }

  /*
   * The address is re-checked against the user row.
   *
   * Somebody can change their email between a code being sent and entered, and
   * a code proving they read the OLD inbox must not mark the NEW address
   * verified — that would turn the feature into a way to launder an
   * unverifiable address through a verifiable one.
   */
  if (record.email !== user.email) {
    await db.emailVerification.update({
      where: { id: record.id },
      data: { consumedAt: now },
    })
    throw new AppError(
      'ADDRESS_CHANGED',
      'Your email address changed after that code was sent. Ask for a new one.',
      400,
    )
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new AppError(
      'TOO_MANY_ATTEMPTS',
      'Too many wrong tries on that code. Ask for a new one.',
      400,
    )
  }

  const presented = Buffer.from(hashCode(params.code.trim()))
  const stored = Buffer.from(record.codeHash)
  const matches = presented.length === stored.length && timingSafeEqual(presented, stored)

  if (!matches) {
    /*
     * The increment is atomic and conditional on the count not having moved.
     *
     * Read-then-write here would let a script fire its guesses concurrently and
     * have them all read attempts=0, which turns a five-guess ceiling into
     * however many requests it can get in flight at once.
     */
    const bumped = await db.emailVerification.updateMany({
      where: { id: record.id, attempts: record.attempts },
      data: { attempts: record.attempts + 1 },
    })
    if (bumped.count === 0) {
      // Somebody else's guess landed between our read and our write. Refuse
      // without counting it rather than guessing at the right number.
      throw new AppError('WRONG_CODE', 'That code is not right. Check and try again.', 400)
    }

    const left = MAX_ATTEMPTS - (record.attempts + 1)
    throw new AppError(
      'WRONG_CODE',
      left > 0
        ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left before you need a new one.`
        : 'That code is not right, and that was the last try. Ask for a new one.',
      400,
    )
  }

  const verifiedAt = await db.$transaction(async (tx) => {
    const spent = await tx.emailVerification.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: now },
    })
    if (spent.count === 0) {
      // Already used by a concurrent request. Whichever won, the address is
      // verified, so read the answer rather than manufacturing a failure.
      const fresh = await tx.user.findUniqueOrThrow({
        where: { id: params.userId },
        select: { emailVerifiedAt: true },
      })
      return fresh.emailVerifiedAt ?? now
    }

    await tx.user.update({
      where: { id: params.userId },
      data: { emailVerifiedAt: now },
    })

    await tx.auditLog.create({
      data: {
        actorId: params.userId, actorType: 'USER', action: 'user.email_verified',
        entityType: 'User', entityId: params.userId,
        after: { at: now.toISOString() },
      },
    })

    return now
  })

  return { verifiedAt }
}

/**
 * The gate.
 *
 * Called by the two actions where a real, reachable person is the point:
 * posting a job (a stranger is coming to your home) and claiming one (you are
 * going to a stranger's home). Deliberately NOT called on sign-in: locking
 * somebody out of an app they just installed, over an email that may be sitting
 * in a spam folder, loses the person rather than the bad actor — who has
 * another address ready.
 */
export async function requireVerifiedEmail(db: Db, userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  })
  if (!user?.emailVerifiedAt) {
    /*
     * Its own code, not a plain FORBIDDEN.
     *
     * Several things in this product answer 403, and the app has to be able to
     * tell THIS one apart: it is the only 403 with a way forward. Anything
     * else and the person taps "Post a job", reads a refusal, and has no idea
     * that a code is sitting in their inbox — which is indistinguishable, from
     * their side, from the app being broken.
     */
    throw new AppError(
      'EMAIL_NOT_VERIFIED',
      'Verify your email address first — we sent you a code.',
      403,
    )
  }
}

/** Housekeeping. Spent and expired rows are not worth keeping. */
export async function purgeExpiredVerifications(db: Db, now = new Date()): Promise<number> {
  const result = await db.emailVerification.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
  })
  return result.count
}
