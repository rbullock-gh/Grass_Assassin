import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, resetDatabase, createCategory, createCustomer, createWorker, createProperty, createJob,
} from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { searchNearbyJobs } from '../modules/geo/job-search.js'

/**
 * Reporting a person, and refusing to be matched with them again.
 *
 * This is the safety surface of a product where a stranger comes onto private
 * property with equipment. The admin queue and the block enforcement both
 * already existed; nothing could feed either of them.
 */
const provider = new FakePaymentProvider()
let app: FastifyInstance

let customerToken: string
let customerId: string
let workerToken: string
let workerUserId: string
let categoryId: string
let propertyId: string

beforeAll(async () => {
  await prisma.$connect()
  app = await buildServer({
    db: prisma,
    provider,
    config: {
      accessSecret: 'test-access-secret-at-least-32-characters-long',
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      ipSalt: 'test-salt',
      isProduction: false,
      publicBaseUrl: 'http://localhost:4000',
      rateLimits: { enabled: false },
    },
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetDatabase()
  const category = await createCategory()
  const customer = await createCustomer()
  const worker = await createWorker({ categoryId: category.id })
  const property = await createProperty(customer.id)

  categoryId = category.id
  propertyId = property.id
  customerId = customer.id
  workerUserId = worker.user.id
  customerToken = await tokenFor(customer.id)
  workerToken = await tokenFor(worker.user.id)
})

async function tokenFor(userId: string): Promise<string> {
  const { signAccessToken } = await import('../modules/auth/tokens.js')
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId }, select: { id: true, roles: true },
  })
  return signAccessToken({
    userId: user.id, roles: user.roles,
    secret: 'test-access-secret-at-least-32-characters-long', ttlSeconds: 900,
  })
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

const REASON = 'He turned up at the house shouting and would not leave when I asked him to.'

const fileReport = (token: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/reports', headers: auth(token), payload: body })

describe('filing a report', () => {
  it('lands in the queue the admin dashboard reads', async () => {
    // That queue shipped complete and permanently empty: nothing could write
    // a row to the table it reads.
    const response = await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'UNSAFE_BEHAVIOUR', description: REASON,
    })

    expect(response.statusCode).toBe(201)
    const report = await prisma.report.findFirstOrThrow()
    expect(report.reporterId).toBe(customerId)
    expect(report.subjectId).toBe(workerUserId)
    expect(report.status).toBe('OPEN')
  })

  it('blocks the person as well, by default', async () => {
    // Somebody reporting a person they felt unsafe around almost always also
    // wants to stop being shown their work. Making that a second deliberate
    // step is asking them to do paperwork about it.
    await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'HARASSMENT', description: REASON,
    })
    expect(await prisma.userBlock.count({
      where: { blockerId: customerId, blockedId: workerUserId },
    })).toBe(1)
  })

  it('can report without blocking, for a third-party or billing complaint', async () => {
    const response = await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'OTHER', description: REASON, alsoBlock: false,
    })
    expect(response.json().blocked).toBe(false)
    expect(await prisma.userBlock.count()).toBe(0)
  })

  it('never automatically suspends the person reported', async () => {
    // The brief is explicit: flag for human review, never make an irreversible
    // automated decision. An automated ban on a false accusation takes away
    // somebody's income and there is no undo that gives the week back.
    await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'UNSAFE_BEHAVIOUR', description: REASON,
    })
    const subject = await prisma.user.findUniqueOrThrow({ where: { id: workerUserId } })
    expect(subject.status).toBe('ACTIVE')
    expect(subject.suspendedUntil).toBeNull()
  })

  it('folds a second report from the same person instead of stacking it', async () => {
    // Three copies of one complaint is three times the review time, and makes a
    // single incident look like a pattern — which is the judgement the reviewer
    // is there to make for themselves.
    await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'NO_SHOW', description: REASON,
    })
    await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'UNSAFE_BEHAVIOUR', description: `${REASON} Again.`,
    })

    const reports = await prisma.report.findMany()
    expect(reports).toHaveLength(1)
    expect(reports[0]!.category).toBe('UNSAFE_BEHAVIOUR')
    expect(reports[0]!.description).toMatch(/Again\./)
  })

  it('keeps a different person\'s report about the same subject separate', async () => {
    const other = await createCustomer()
    const otherToken = await tokenFor(other.id)
    await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'NO_SHOW', description: REASON,
    })
    await fileReport(otherToken, {
      subjectUserId: workerUserId, category: 'NO_SHOW', description: REASON,
    })
    expect(await prisma.report.count()).toBe(2)
  })

  it('refuses a description too short to act on', async () => {
    const response = await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'OTHER', description: 'bad',
    })
    expect(response.statusCode).toBe(400)
    expect(await prisma.report.count()).toBe(0)
  })

  it('refuses a report about yourself', async () => {
    const response = await fileReport(customerToken, {
      subjectUserId: customerId, category: 'OTHER', description: REASON,
    })
    expect(response.statusCode).toBe(409)
  })

  it('refuses a report about somebody who does not exist', async () => {
    const response = await fileReport(customerToken, {
      subjectUserId: 'nobody', category: 'OTHER', description: REASON,
    })
    expect(response.statusCode).toBe(404)
  })

  it('refuses an anonymous report', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/reports',
      payload: { subjectUserId: workerUserId, category: 'OTHER', description: REASON },
    })
    expect(response.statusCode).toBe(401)
  })

  it('attaches a job both people were actually on', async () => {
    const job = await createJob({
      customerId, propertyId, categoryId, status: 'CLAIMED', claimedByWorkerId: workerUserId,
    })

    await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'PROPERTY_DAMAGE', description: REASON, jobId: job.id,
    })
    expect((await prisma.report.findFirstOrThrow()).jobId).toBe(job.id)
  })

  it('drops a job link to a job the reporter had nothing to do with', async () => {
    // Otherwise a report can attach an accusation to a stranger's job, and the
    // reviewer opens a case file that looks corroborated and is not.
    const stranger = await createCustomer()
    const strangerProperty = await createProperty(stranger.id)
    const notMine = await createJob({
      customerId: stranger.id, propertyId: strangerProperty.id, categoryId,
    })

    const response = await fileReport(customerToken, {
      subjectUserId: workerUserId, category: 'OTHER', description: REASON, jobId: notMine.id,
    })

    // The report is still filed — arguing about metadata with someone trying to
    // report being threatened is the wrong trade.
    expect(response.statusCode).toBe(201)
    expect((await prisma.report.findFirstOrThrow()).jobId).toBeNull()
  })
})

describe('blocking', () => {
  const blockRequest = (token: string, blockedUserId: string) =>
    app.inject({ method: 'POST', url: '/v1/blocks', headers: auth(token), payload: { blockedUserId } })

  it('takes the blocked person\'s jobs off the map immediately', async () => {
    // The enforcement was already here and correct. Nothing could switch it on.
    const job = await createJob({ customerId, propertyId, categoryId })

    const before = await searchNearbyJobs(prisma, {
      center: { lat: 36.1627, lng: -86.7816 }, radiusMiles: 25,
      sort: 'DISTANCE', limit: 25, viewerUserId: workerUserId,
    })
    expect(before.map((j) => j.id)).toContain(job.id)

    expect((await blockRequest(workerToken, customerId)).statusCode).toBe(201)

    const after = await searchNearbyJobs(prisma, {
      center: { lat: 36.1627, lng: -86.7816 }, radiusMiles: 25,
      sort: 'DISTANCE', limit: 25, viewerUserId: workerUserId,
    })
    expect(after.map((j) => j.id)).not.toContain(job.id)
  })

  it('works in the other direction too', async () => {
    // A customer who blocks a worker must not have that worker turn up on
    // their job, which means the worker must not see the job either.
    const job = await createJob({ customerId, propertyId, categoryId })
    await blockRequest(customerToken, workerUserId)

    const after = await searchNearbyJobs(prisma, {
      center: { lat: 36.1627, lng: -86.7816 }, radiusMiles: 25,
      sort: 'DISTANCE', limit: 25, viewerUserId: workerUserId,
    })
    expect(after.map((j) => j.id)).not.toContain(job.id)
  })

  it('is idempotent, because a frustrated person taps twice', async () => {
    await blockRequest(customerToken, workerUserId)
    expect((await blockRequest(customerToken, workerUserId)).statusCode).toBe(201)
    expect(await prisma.userBlock.count()).toBe(1)
  })

  it('refuses to block yourself', async () => {
    expect((await blockRequest(customerToken, customerId)).statusCode).toBe(409)
  })

  it('lists who you have blocked, so it can be undone', async () => {
    await blockRequest(customerToken, workerUserId)
    const response = await app.inject({ method: 'GET', url: '/v1/blocks', headers: auth(customerToken) })
    expect(response.statusCode).toBe(200)
    expect(response.json().blocks).toHaveLength(1)
    expect(response.json().blocks[0].blocked.id).toBe(workerUserId)
  })

  it('only lists your own blocks', async () => {
    await blockRequest(customerToken, workerUserId)
    const response = await app.inject({ method: 'GET', url: '/v1/blocks', headers: auth(workerToken) })
    expect(response.json().blocks).toHaveLength(0)
  })

  it('unblocks, and the jobs come back', async () => {
    const job = await createJob({ customerId, propertyId, categoryId })
    await blockRequest(workerToken, customerId)

    const response = await app.inject({
      method: 'DELETE', url: `/v1/blocks/${customerId}`, headers: auth(workerToken),
    })
    expect(response.statusCode).toBe(204)

    const after = await searchNearbyJobs(prisma, {
      center: { lat: 36.1627, lng: -86.7816 }, radiusMiles: 25,
      sort: 'DISTANCE', limit: 25, viewerUserId: workerUserId,
    })
    expect(after.map((j) => j.id)).toContain(job.id)
  })

  it('cannot unblock on somebody else\'s behalf', async () => {
    await blockRequest(customerToken, workerUserId)
    await app.inject({
      method: 'DELETE', url: `/v1/blocks/${workerUserId}`, headers: auth(workerToken),
    })
    expect(await prisma.userBlock.count()).toBe(1)
  })
})

describe('a block stops messages, not only the map', () => {
  async function jobWithThread() {
    const job = await createJob({
      customerId, propertyId, categoryId, status: 'CLAIMED', claimedByWorkerId: workerUserId,
    })
    await prisma.conversation.create({
      data: { jobId: job.id, customerId, workerId: workerUserId },
    })
    return job
  }

  const send = (token: string, jobId: string) => app.inject({
    method: 'POST', url: `/v1/jobs/${jobId}/messages`,
    headers: auth(token), payload: { body: 'Are you coming today?' },
  })

  it('lets them talk before anybody blocks', async () => {
    const job = await jobWithThread()
    expect((await send(workerToken, job.id)).statusCode).toBe(201)
  })

  it('stops the blocked person writing to the person who blocked them', async () => {
    // Job search excluded blocked pairs; the thread did not. Someone who
    // blocked a person they felt unsafe around could still be messaged by them
    // on the job they shared — the exact conversation they were leaving.
    const job = await jobWithThread()
    await app.inject({
      method: 'POST', url: '/v1/blocks', headers: auth(customerToken),
      payload: { blockedUserId: workerUserId },
    })

    const response = await send(workerToken, job.id)
    expect(response.statusCode).toBe(409)
    expect(await prisma.message.count()).toBe(0)
  })

  it('does not tell the blocked person they were blocked', async () => {
    // Telling someone they have been blocked by a person whose address they
    // know is how a safety feature becomes a provocation.
    const job = await jobWithThread()
    await app.inject({
      method: 'POST', url: '/v1/blocks', headers: auth(customerToken),
      payload: { blockedUserId: workerUserId },
    })

    const body = (await send(workerToken, job.id)).json()
    expect(JSON.stringify(body)).not.toMatch(/block/i)
  })

  it('tells the person who DID block plainly, and how to undo it', async () => {
    const job = await jobWithThread()
    await app.inject({
      method: 'POST', url: '/v1/blocks', headers: auth(customerToken),
      payload: { blockedUserId: workerUserId },
    })

    const body = (await send(customerToken, job.id)).json()
    expect(body.error.message).toMatch(/unblock/i)
  })

  it('lets them talk again after an unblock', async () => {
    const job = await jobWithThread()
    await app.inject({
      method: 'POST', url: '/v1/blocks', headers: auth(customerToken),
      payload: { blockedUserId: workerUserId },
    })
    await app.inject({
      method: 'DELETE', url: `/v1/blocks/${workerUserId}`, headers: auth(customerToken),
    })
    expect((await send(workerToken, job.id)).statusCode).toBe(201)
  })
})
