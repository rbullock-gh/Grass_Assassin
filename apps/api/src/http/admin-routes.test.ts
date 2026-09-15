import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker,
  createProperty, createJob,
} from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { captureForClaim } from '../modules/payments/settlement.js'
import { attemptClaim } from '../modules/jobs/claim.js'
import { ledgerIsBalanced } from '../modules/payments/ledger.js'

/**
 * The admin dispute endpoint, tested as an attacker would reach it.
 *
 * This is the most dangerous route in the system: it issues refunds and pays
 * workers, and it is reached by a service token rather than a user's login. So
 * the questions here are mostly not "does it work" but "what happens when the
 * caller is lying" — about the token, about which administrator is acting, and
 * about whether that person is still allowed to.
 */
const SERVICE_TOKEN = 'a-test-service-token-at-least-32-characters'
const provider = new FakePaymentProvider()
let app: FastifyInstance

let categoryId: string
let customerId: string
let propertyId: string
let workerUserId: string
let adminId: string

beforeAll(async () => {
  await prisma.$connect()
  process.env.ADMIN_SERVICE_TOKEN = SERVICE_TOKEN
  app = await buildServer({
    db: prisma,
    provider,
    config: {
      accessSecret: 'test-access-secret-at-least-32-characters-long',
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      ipSalt: 'test-salt',
      isProduction: false,
      rateLimits: { enabled: false },
    },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
  delete process.env.ADMIN_SERVICE_TOKEN
})

beforeEach(async () => {
  await resetDatabase()
  provider.reset()
  process.env.ADMIN_SERVICE_TOKEN = SERVICE_TOKEN

  const category = await createCategory()
  const customer = await createCustomer()
  const property = await createProperty(customer.id)
  const worker = await createWorker({ categoryId: category.id })

  categoryId = category.id
  customerId = customer.id
  propertyId = property.id
  workerUserId = worker.user.id

  await prisma.customerProfile.update({
    where: { userId: customerId },
    data: { stripeCustomerId: 'cus_test_1', defaultPaymentMethodId: 'pm_test_visa' },
  })
  await prisma.workerProfile.update({
    where: { userId: workerUserId },
    data: { stripeAccountId: 'acct_test_1', payoutsEnabled: true, chargesEnabled: true },
  })

  const admin = await prisma.user.create({
    data: {
      email: 'admin@test.local',
      passwordHash: 'not-used-on-this-path',
      firstName: 'Ada',
      roles: { set: ['ADMIN'] },
      status: 'ACTIVE',
    },
    select: { id: true },
  })
  adminId = admin.id
})

async function disputedJob(priceCents = 10_000) {
  const job = await createJob({ customerId, propertyId, categoryId, priceCents, status: 'POSTED' })
  await attemptClaim(prisma, { jobId: job.id, workerUserId })
  await captureForClaim({ db: prisma, provider }, { jobId: job.id, workerUserId })
  await prisma.job.update({ where: { id: job.id }, data: { status: 'DISPUTED' } })
  const dispute = await prisma.dispute.create({
    data: {
      jobId: job.id, openedById: customerId, againstId: workerUserId,
      reason: 'INCOMPLETE', description: 'The back half was not cut at all.', status: 'OPEN',
    },
    select: { id: true },
  })
  return { jobId: job.id, disputeId: dispute.id }
}

const RESOLUTION = 'Photos show the front was cut and the back was not. Splitting the difference.'

function resolve(disputeId: string, headers: Record<string, string>, body: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/v1/admin/disputes/${disputeId}/resolve`,
    headers,
    payload: { decision: 'WORKER', resolution: RESOLUTION, ...(body as object) },
  })
}

const good = () => ({ 'x-service-token': SERVICE_TOKEN, 'x-acting-admin-id': adminId })

describe('who may resolve a dispute', () => {
  it('accepts our dashboard acting for a real administrator', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, good())
    expect(response.statusCode).toBe(200)
    expect(response.json().decision).toBe('WORKER')
  })

  it('refuses a request with no service token', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, { 'x-acting-admin-id': adminId })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a wrong service token', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, {
      'x-service-token': 'a-wrong-token-of-exactly-the-same-length-x'.slice(0, SERVICE_TOKEN.length),
      'x-acting-admin-id': adminId,
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a valid token with no administrator named', async () => {
    // The token alone would leave the audit trail anonymous, which is the whole
    // problem this path exists to avoid.
    const job = await disputedJob()
    const response = await resolve(job.disputeId, { 'x-service-token': SERVICE_TOKEN })
    expect(response.statusCode).toBe(403)
  })

  it('refuses when the named administrator does not exist', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, {
      'x-service-token': SERVICE_TOKEN, 'x-acting-admin-id': 'no-such-user',
    })
    expect(response.statusCode).toBe(403)
  })

  it('refuses when the named user is a customer, not an administrator', async () => {
    // A compromised dashboard must not be able to act as an arbitrary user.
    const job = await disputedJob()
    const response = await resolve(job.disputeId, {
      'x-service-token': SERVICE_TOKEN, 'x-acting-admin-id': customerId,
    })
    expect(response.statusCode).toBe(403)
  })

  it.each([
    ['suspended', { status: 'SUSPENDED' as const }],
    ['banned', { status: 'BANNED' as const }],
    ['soft-deleted', { deletedAt: new Date() }],
    ['inside a suspension window', { suspendedUntil: new Date(Date.now() + 86_400_000) }],
  ])('refuses an administrator who is %s', async (_label, data) => {
    const job = await disputedJob()
    await prisma.user.update({ where: { id: adminId }, data })
    const response = await resolve(job.disputeId, good())
    expect(response.statusCode).toBe(403)
  })

  it('refuses everything when no service token is configured', async () => {
    // Failing closed: an unset secret must not mean "no check required".
    const job = await disputedJob()
    delete process.env.ADMIN_SERVICE_TOKEN
    const response = await resolve(job.disputeId, good())
    expect(response.statusCode).toBe(403)
  })

  it('refuses a genuinely valid user login on this route', async () => {
    // A real account, a real password, a real access token minted by our own
    // auth. The earlier version of this test sent the string "anything", which
    // is refused for being a malformed token and therefore proved nothing
    // about a valid one.
    const job = await disputedJob()
    const registration = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: {
        email: 'someone@test.local', password: 'a-sufficiently-long-password',
        firstName: 'Sam', intent: 'CUSTOMER',
      },
    })
    expect(registration.statusCode).toBe(201)
    const token = registration.json().tokens.accessToken as string
    expect(typeof token).toBe('string')

    const response = await app.inject({
      method: 'POST',
      url: `/v1/admin/disputes/${job.disputeId}/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: 'WORKER', resolution: RESOLUTION },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses even a real administrator bearing only their own login', async () => {
    // Deliberate: this route is for the dashboard, and the dashboard proves
    // itself with the service token. An admin's user token is not a substitute,
    // so a stolen one cannot issue refunds.
    const job = await disputedJob()
    const registration = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: {
        email: 'realadmin@test.local', password: 'a-sufficiently-long-password',
        firstName: 'Grace', intent: 'CUSTOMER',
      },
    })
    const token = registration.json().tokens.accessToken as string
    await prisma.user.update({
      where: { email: 'realadmin@test.local' },
      data: { roles: { set: ['ADMIN'] } },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/v1/admin/disputes/${job.disputeId}/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: 'WORKER', resolution: RESOLUTION },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('what a resolution must say', () => {
  it('refuses a decision that is not one of the three', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, good(), { decision: 'MAYBE' })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a resolution too short to explain anything', async () => {
    // This text is what both parties are told and what a reviewer later has to
    // go on. "ok" protects nobody.
    const job = await disputedJob()
    const response = await resolve(job.disputeId, good(), { resolution: 'ok' })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a split with no amount', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, good(), { decision: 'SPLIT' })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a split refund larger than the customer paid', async () => {
    const job = await disputedJob(10_000)
    const response = await resolve(job.disputeId, good(), {
      decision: 'SPLIT', refundCents: 999_999,
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a negative refund', async () => {
    const job = await disputedJob()
    const response = await resolve(job.disputeId, good(), {
      decision: 'SPLIT', refundCents: -500,
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('the money and the record', () => {
  it('names the real administrator on the dispute and the audit log', async () => {
    const job = await disputedJob()
    await resolve(job.disputeId, good())

    const dispute = await prisma.dispute.findUniqueOrThrow({
      where: { id: job.disputeId },
      select: { resolvedById: true, status: true, resolution: true },
    })
    expect(dispute.resolvedById).toBe(adminId)
    expect(dispute.status).toBe('RESOLVED_WORKER')
    expect(dispute.resolution).toBe(RESOLUTION)

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'dispute.resolved', entityId: job.disputeId },
      select: { actorId: true, actorType: true },
    })
    expect(audit?.actorId).toBe(adminId)
    expect(audit?.actorType).toBe('ADMIN')
  })

  it('leaves the books balanced after a split', async () => {
    const job = await disputedJob(10_000)
    const response = await resolve(job.disputeId, good(), {
      decision: 'SPLIT', refundCents: 4_000,
    })
    expect(response.statusCode).toBe(200)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)

    const body = response.json()
    expect(body.customerRefundCents + body.workerPaidCents + body.platformRetainedCents)
      .toBe(10_000 + (await jobServiceFee(job.jobId)))
  })

  it('refuses to resolve the same dispute twice', async () => {
    // Without this, a double-click pays the worker twice.
    const job = await disputedJob()
    expect((await resolve(job.disputeId, good())).statusCode).toBe(200)
    const second = await resolve(job.disputeId, good())
    expect(second.statusCode).toBe(409)
    expect((await ledgerIsBalanced(prisma)).balanced).toBe(true)
  })

  it('404s for a dispute that does not exist', async () => {
    const response = await resolve('no-such-dispute', good())
    expect(response.statusCode).toBe(404)
  })
})

async function jobServiceFee(jobId: string): Promise<number> {
  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId }, select: { serviceFeeCents: true },
  })
  return job.serviceFeeCents
}
