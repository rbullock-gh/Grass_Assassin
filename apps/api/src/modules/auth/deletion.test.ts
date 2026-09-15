import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker, createProperty, createJob,
} from '../../../test/factories.js'
import { deleteAccount, deletionBlockers } from './deletion.js'
import { hashPassword } from './password.js'
import { ledgerIsBalanced } from '../payments/ledger.js'

/**
 * Deleting an account.
 *
 * The happy path is the least interesting part. What matters is what this
 * REFUSES — somebody who is holding a job, owed money, or in a dispute cannot
 * be allowed to vanish — and what it deliberately keeps, because a job the
 * other party worked is not solely the deleting user's record to erase.
 */
const PASSWORD = 'CorrectHorseBattery1'

let categoryId: string

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => {
  await resetDatabase()
  categoryId = (await createCategory()).id
})

/** A customer whose password we know, since deletion requires it. */
async function customerWithPassword() {
  const customer = await createCustomer()
  await prisma.user.update({
    where: { id: customer.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  })
  return customer
}

async function workerWithPassword() {
  const worker = await createWorker({ categoryId })
  await prisma.user.update({
    where: { id: worker.user.id },
    data: { passwordHash: await hashPassword(PASSWORD) },
  })
  return worker
}

describe('what stops somebody deleting', () => {
  it('lets a person with nothing outstanding go', async () => {
    const customer = await customerWithPassword()
    expect(await deletionBlockers(prisma, customer.id)).toEqual([])
  })

  it('refuses a worker holding a job somebody is waiting on', async () => {
    const customer = await customerWithPassword()
    const worker = await workerWithPassword()
    const property = await createProperty(customer.id)
    await createJob({
      customerId: customer.id, propertyId: property.id, categoryId,
      status: 'CLAIMED', claimedByWorkerId: worker.user.id,
    })

    const blockers = await deletionBlockers(prisma, worker.user.id)
    expect(blockers.map((b) => b.code)).toContain('ACTIVE_JOB_AS_WORKER')
    // The message says what to do, not just that something is wrong.
    expect(blockers[0]!.message).toMatch(/finish or cancel/i)
  })

  it('refuses a customer whose job a pro is partway through', async () => {
    const customer = await customerWithPassword()
    const worker = await workerWithPassword()
    const property = await createProperty(customer.id)
    await createJob({
      customerId: customer.id, propertyId: property.id, categoryId,
      status: 'CLAIMED', claimedByWorkerId: worker.user.id,
    })

    expect((await deletionBlockers(prisma, customer.id)).map((b) => b.code))
      .toContain('ACTIVE_JOB_AS_CUSTOMER')
  })

  it('does not count a finished job', async () => {
    const customer = await customerWithPassword()
    const property = await createProperty(customer.id)
    await createJob({ customerId: customer.id, propertyId: property.id, categoryId })
    // POSTED is not an active claim — nobody is waiting on this person.
    expect(await deletionBlockers(prisma, customer.id)).toEqual([])
  })

  it('refuses while a dispute is still being decided', async () => {
    const customer = await customerWithPassword()
    const worker = await workerWithPassword()
    const property = await createProperty(customer.id)
    const job = await createJob({
      customerId: customer.id, propertyId: property.id, categoryId,
      status: 'CLAIMED', claimedByWorkerId: worker.user.id,
    })
    await prisma.job.update({ where: { id: job.id }, data: { status: 'CLOSED' } })
    await prisma.dispute.create({
      data: {
        jobId: job.id, openedById: customer.id, againstId: worker.user.id,
        reason: 'INCOMPLETE', description: 'Half the lawn was left.', status: 'OPEN',
      },
    })

    for (const userId of [customer.id, worker.user.id]) {
      const codes = (await deletionBlockers(prisma, userId)).map((b) => b.code)
      expect(codes, `blockers for ${userId}`).toContain('OPEN_DISPUTE')
    }
  })

  it('refuses while we are still holding their money', async () => {
    // Deleting the account that owns an unwithdrawn balance means we keep it,
    // which is theft with extra steps.
    const worker = await workerWithPassword()
    await prisma.workerProfile.update({
      where: { id: worker.profile.id }, data: { availableBalanceCents: 4_250 },
    })

    const blockers = await deletionBlockers(prisma, worker.user.id)
    expect(blockers.map((b) => b.code)).toContain('UNWITHDRAWN_BALANCE')
    expect(blockers.find((b) => b.code === 'UNWITHDRAWN_BALANCE')!.message).toContain('$42.50')
  })

  it('refuses while money is still clearing, and says when', async () => {
    const worker = await workerWithPassword()
    await prisma.workerProfile.update({
      where: { id: worker.profile.id }, data: { pendingBalanceCents: 9_900 },
    })
    const blocker = (await deletionBlockers(prisma, worker.user.id))
      .find((b) => b.code === 'PENDING_BALANCE')!
    expect(blocker.message).toContain('$99.00')
    expect(blocker.message).toMatch(/few days/i)
  })

  it('reports every blocker at once rather than one at a time', async () => {
    const customer = await customerWithPassword()
    const worker = await workerWithPassword()
    const property = await createProperty(customer.id)
    await createJob({
      customerId: customer.id, propertyId: property.id, categoryId,
      status: 'CLAIMED', claimedByWorkerId: worker.user.id,
    })
    await prisma.workerProfile.update({
      where: { id: worker.profile.id }, data: { availableBalanceCents: 1_000 },
    })

    const codes = (await deletionBlockers(prisma, worker.user.id)).map((b) => b.code)
    expect(codes).toContain('ACTIVE_JOB_AS_WORKER')
    expect(codes).toContain('UNWITHDRAWN_BALANCE')
  })
})

describe('deleting', () => {
  it('needs the password', async () => {
    const customer = await customerWithPassword()
    await expect(deleteAccount(prisma, { userId: customer.id, password: 'not-it' }))
      .rejects.toThrow(/not your password/i)

    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })
    expect(after.deletedAt).toBeNull()
  })

  it('refuses when there is a blocker, even with the right password', async () => {
    const customer = await customerWithPassword()
    const worker = await workerWithPassword()
    const property = await createProperty(customer.id)
    await createJob({
      customerId: customer.id, propertyId: property.id, categoryId,
      status: 'CLAIMED', claimedByWorkerId: worker.user.id,
    })

    await expect(deleteAccount(prisma, { userId: worker.user.id, password: PASSWORD }))
      .rejects.toThrow(/finish or cancel/i)
  })

  it('removes the personal details', async () => {
    const customer = await customerWithPassword()
    const originalEmail = (await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).email

    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })
    expect(after.deletedAt).not.toBeNull()
    expect(after.email).not.toBe(originalEmail)
    expect(after.email).toMatch(/@deleted\.invalid$/)
    expect(after.phone).toBeNull()
    expect(after.lastName).toBeNull()
    expect(after.avatarUrl).toBeNull()
    expect(after.firstName).toBe('Former member')
  })

  it('frees the email address for a fresh sign-up', async () => {
    // Otherwise deleting an account means that person can never come back, and
    // the unique index is a life sentence.
    const customer = await customerWithPassword()
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).email

    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    const reused = await prisma.user.create({
      data: { email, passwordHash: 'x', firstName: 'Back again', roles: ['CUSTOMER'] },
    })
    expect(reused.id).not.toBe(customer.id)
  })

  it('takes the push tokens with it', async () => {
    // A deleted account that keeps buzzing a phone is the most visible possible
    // failure of this whole operation.
    const customer = await customerWithPassword()
    await prisma.device.create({
      data: { userId: customer.id, pushToken: 'ExponentPushToken[bye0000000000000000]', platform: 'ios' },
    })

    const summary = await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })
    expect(summary.removed.devices).toBe(1)
    expect(await prisma.device.count({ where: { userId: customer.id } })).toBe(0)
  })

  it('takes the street address off their properties', async () => {
    const customer = await customerWithPassword()
    const property = await createProperty(customer.id)

    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } })
    expect(after.addressLine1).not.toMatch(/Evergreen/)
    expect(after.archivedAt).not.toBeNull()
    // City stays: it is on the JOB too, as the worker's record of where they worked.
    expect(after.city).toBe('Nashville')
  })

  it('keeps the jobs, because they are the other party\'s record too', async () => {
    const customer = await customerWithPassword()
    const worker = await workerWithPassword()
    const property = await createProperty(customer.id)
    const job = await createJob({
      customerId: customer.id, propertyId: property.id, categoryId,
      status: 'CLAIMED', claimedByWorkerId: worker.user.id,
    })
    await prisma.job.update({ where: { id: job.id }, data: { status: 'CLOSED' } })

    const summary = await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    expect(summary.kept.jobs).toBeGreaterThan(0)
    expect(await prisma.job.findUnique({ where: { id: job.id } })).not.toBeNull()
  })

  it('leaves the ledger alone and still balanced', async () => {
    // Deleting a user is not a financial event and must not look like one.
    const customer = await customerWithPassword()
    const before = await prisma.ledgerEntry.count()

    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    expect(await prisma.ledgerEntry.count()).toBe(before)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('signs every session out', async () => {
    const customer = await customerWithPassword()
    await prisma.refreshToken.create({
      data: {
        userId: customer.id, tokenHash: 'whatever', familyId: 'f1',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })

    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    expect(await prisma.refreshToken.count({
      where: { userId: customer.id, revokedAt: null },
    })).toBe(0)
  })

  it('records that it happened, without recording who', async () => {
    const customer = await customerWithPassword()
    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'user.deleted', entityId: customer.id },
    })
    // Writing the email into the audit row would defeat removing it from the
    // user row.
    expect(JSON.stringify(audit.after)).not.toMatch(/@example\.com/)
    expect(audit.actorId).toBeNull()
  })

  it('cannot be done twice', async () => {
    const customer = await customerWithPassword()
    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })
    await expect(deleteAccount(prisma, { userId: customer.id, password: PASSWORD }))
      .rejects.toThrow()
  })

  it('leaves a password that cannot be signed in with', async () => {
    const customer = await customerWithPassword()
    await deleteAccount(prisma, { userId: customer.id, password: PASSWORD })

    const { verifyPassword } = await import('./password.js')
    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })
    // A real hash, not a blank: verifying against a malformed hash THROWS,
    // which would turn a sign-in attempt on a deleted account into a 500.
    await expect(verifyPassword(after.passwordHash, PASSWORD)).resolves.toBe(false)
  })
})
