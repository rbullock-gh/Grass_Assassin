import type { Db } from '../../lib/prisma.js'
import { ACTIVE_CLAIM_STATUSES } from '@grassassassin/shared'
import { verifyPassword, hashPassword } from './password.js'
import { UnauthorizedError, ConflictError } from '../../lib/errors.js'
import { revokeAllSessions } from './tokens.js'

/**
 * Deleting an account.
 *
 * Required by both stores — Apple 5.1.1(v) and Google Play — and until now the
 * schema had `deletedAt`, the auth context refused anyone carrying it, and
 * nothing in the product could ever set it.
 *
 * Three things pull against each other here, and pretending they do not is how
 * you get either a store rejection or a lawsuit:
 *
 * A PERSON IS OWED THEIR DATA BEING GONE. So the personal details go: email,
 * phone, name, avatar, street addresses, push tokens, sessions.
 *
 * THE OTHER PARTY IS OWED THE RECORD. A job someone else worked, the money that
 * moved, the review they were given, the dispute that was decided — none of that
 * is solely the deleting user's to erase. It stays, with the person on it
 * anonymised.
 *
 * AND THE BOOKS MUST STILL BALANCE. The ledger is append-only and is never
 * touched. Deleting a user is not a financial event and must not look like one.
 *
 * Hence a soft delete with anonymisation rather than a row deletion, and a hard
 * refusal while the person still owes somebody something.
 */

export type DeletionBlockerCode =
  | 'ACTIVE_JOB_AS_WORKER'
  | 'ACTIVE_JOB_AS_CUSTOMER'
  | 'OPEN_DISPUTE'
  | 'UNWITHDRAWN_BALANCE'
  | 'PENDING_BALANCE'

export interface DeletionBlocker {
  code: DeletionBlockerCode
  /** Shown to the person. Says what to do, not just what is wrong. */
  message: string
}

/**
 * What stands between this person and deletion, in the order they should fix it.
 *
 * Returned rather than thrown so the app can show the whole list at once.
 * Finding out about three blockers one refusal at a time is its own small
 * cruelty.
 */
export async function deletionBlockers(db: Db, userId: string): Promise<DeletionBlocker[]> {
  const activeStatuses = ACTIVE_CLAIM_STATUSES as unknown as string[]

  const [asWorker, asCustomer, disputes, profile] = await Promise.all([
    db.job.count({
      where: { claimedByWorkerId: userId, status: { in: activeStatuses as never } },
    }),
    db.job.count({
      where: { customerId: userId, status: { in: activeStatuses as never } },
    }),
    db.dispute.count({
      where: {
        status: { in: ['OPEN', 'UNDER_REVIEW'] },
        OR: [{ openedById: userId }, { againstId: userId }],
      },
    }),
    db.workerProfile.findUnique({
      where: { userId },
      select: { availableBalanceCents: true, pendingBalanceCents: true },
    }),
  ])

  const blockers: DeletionBlocker[] = []

  if (asWorker > 0) {
    blockers.push({
      code: 'ACTIVE_JOB_AS_WORKER',
      message: asWorker === 1
        ? 'You are holding a job somebody is expecting you to do. Finish or cancel it first.'
        : `You are holding ${asWorker} jobs somebody is expecting you to do. Finish or cancel them first.`,
    })
  }

  if (asCustomer > 0) {
    blockers.push({
      code: 'ACTIVE_JOB_AS_CUSTOMER',
      message: asCustomer === 1
        ? 'A pro is partway through a job for you. Approve or cancel it first.'
        : `Pros are partway through ${asCustomer} jobs for you. Approve or cancel them first.`,
    })
  }

  if (disputes > 0) {
    blockers.push({
      code: 'OPEN_DISPUTE',
      message: 'A dispute involving you is still being decided. It has to be settled first — '
        + 'money is being held over it.',
    })
  }

  /*
   * Money is checked separately from jobs because it outlives them. A settled
   * job leaves a balance behind, and deleting the account that owns it would
   * mean we keep it — which is theft with extra steps.
   */
  if ((profile?.availableBalanceCents ?? 0) > 0) {
    const amount = `$${((profile?.availableBalanceCents ?? 0) / 100).toFixed(2)}`
    blockers.push({
      code: 'UNWITHDRAWN_BALANCE',
      message: `You have ${amount} that has not been paid out. Withdraw it first — we are not keeping it.`,
    })
  }

  if ((profile?.pendingBalanceCents ?? 0) > 0) {
    const amount = `$${((profile?.pendingBalanceCents ?? 0) / 100).toFixed(2)}`
    blockers.push({
      code: 'PENDING_BALANCE',
      message: `${amount} is still clearing from work you have done. It lands in a few days, `
        + 'and you can withdraw it then.',
    })
  }

  return blockers
}

/** What actually goes, so the confirmation screen is not guessing. */
export interface DeletionSummary {
  /** Rows whose personal content is removed outright. */
  removed: { devices: number; properties: number; blocks: number }
  /** Records kept because they are somebody else's too. */
  kept: { jobs: number; reviews: number }
}

/**
 * Soft-deletes and anonymises.
 *
 * The password is required. An account is not something an unattended phone
 * should be able to destroy, and "are you sure" is not a meaningful barrier for
 * somebody who has already picked the thing up.
 */
export async function deleteAccount(db: Db, params: {
  userId: string
  password: string
  now?: Date
}): Promise<DeletionSummary> {
  const now = params.now ?? new Date()

  const user = await db.user.findUniqueOrThrow({
    where: { id: params.userId },
    select: { id: true, passwordHash: true, deletedAt: true },
  })

  if (user.deletedAt) {
    throw new ConflictError('ALREADY_DELETED', 'This account is already deleted.')
  }
  if (!(await verifyPassword(user.passwordHash, params.password))) {
    throw new UnauthorizedError('That is not your password')
  }

  const blockers = await deletionBlockers(db, params.userId)
  if (blockers.length > 0) {
    throw new ConflictError('CANNOT_DELETE_YET', blockers[0]!.message, { blockers })
  }

  const [jobs, reviews] = await Promise.all([
    db.job.count({ where: { OR: [{ customerId: params.userId }, { claimedByWorkerId: params.userId }] } }),
    db.review.count({ where: { authorId: params.userId } }),
  ])

  /*
   * A hash of something nobody knows.
   *
   * Not an empty string and not a literal: argon2 verification against a
   * malformed hash throws rather than returning false, which would turn a sign-in
   * attempt on a deleted account into a 500. This is a real hash of a value that
   * exists for one statement and is then unreachable.
   */
  const deadPassword = await hashPassword(
    `deleted-${params.userId}-${now.getTime()}-${Math.random().toString(36).slice(2)}`,
  )

  const result = await db.$transaction(async (tx) => {
    // Push stops immediately. A deleted account that keeps buzzing a phone is
    // the most visible possible failure of this whole operation.
    const devices = await tx.device.deleteMany({ where: { userId: params.userId } })

    /*
     * Street addresses go. The city and state stay on the JOB, which is the
     * worker's record of where they worked — but the property row itself
     * carries the door number, and that is the deleting person's alone.
     */
    const properties = await tx.property.updateMany({
      where: { ownerId: params.userId },
      data: {
        archivedAt: now,
        addressLine1: '[deleted]',
        addressLine2: null,
        accessNotes: null,
        label: 'Removed property',
      },
    })

    const blocks = await tx.userBlock.deleteMany({
      where: { OR: [{ blockerId: params.userId }, { blockedId: params.userId }] },
    })

    await tx.notificationPreference.deleteMany({ where: { userId: params.userId } })

    await tx.user.update({
      where: { id: params.userId },
      data: {
        deletedAt: now,
        // Unique, so it cannot simply be blanked. Keyed by id so two deletions
        // never collide, and on a domain reserved by RFC 2606 so it can never
        // reach a real inbox.
        email: `deleted-${params.userId}@deleted.invalid`,
        phone: null,
        firstName: 'Former member',
        lastName: null,
        avatarUrl: null,
        passwordHash: deadPassword,
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        suspensionReason: null,
      },
    })

    await tx.auditLog.create({
      data: {
        actorId: null,
        actorType: 'USER',
        action: 'user.deleted',
        entityType: 'User',
        entityId: params.userId,
        // No personal data in the audit row: writing the email here would
        // defeat the point of removing it from the user row.
        after: { jobsKept: jobs, reviewsKept: reviews, deletedAt: now.toISOString() },
      },
    })

    return { devices: devices.count, properties: properties.count, blocks: blocks.count }
  })

  // Outside the transaction: revoking sessions is idempotent, and a deletion
  // that committed but failed here would otherwise roll back the whole thing
  // over something that can simply be retried.
  await revokeAllSessions(db, params.userId)

  return { removed: result, kept: { jobs, reviews } }
}
