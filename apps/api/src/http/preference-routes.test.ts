import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma, resetDatabase, createCategory, createCustomer, createWorker } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { Notifier, RecordingPushSender } from '../modules/notifications/notifier.js'

/**
 * Turning notifications off, and it actually taking effect.
 *
 * The table these write to has been consulted on every send since the notifier
 * was written, and nothing could write a row to it. The test that matters is
 * not that the endpoint returns 200 — it is that the notifier then stops
 * sending.
 */
const provider = new FakePaymentProvider()
let app: FastifyInstance
let workerToken: string
let workerUserId: string
let customerToken: string

const PUSH_TOKEN = 'ExponentPushToken[settingscheck00000000]'

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
  const worker = await createWorker({ categoryId: category.id })
  const customer = await createCustomer()
  workerUserId = worker.user.id
  workerToken = await tokenFor(worker.user.id)
  customerToken = await tokenFor(customer.id)
  await prisma.device.create({
    data: { userId: workerUserId, pushToken: PUSH_TOKEN, platform: 'ios' },
  })
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

const read = (token: string) =>
  app.inject({ method: 'GET', url: '/v1/notification-preferences', headers: auth(token) })

const write = (token: string, groups: Record<string, boolean>) =>
  app.inject({
    method: 'PUT', url: '/v1/notification-preferences',
    headers: auth(token), payload: { groups },
  })

describe('reading what you are signed up for', () => {
  it('starts with everything on, having never been set', () => {
    // Opt-out, matching the notifier. Somebody who has never opened this
    // screen still hears about the job they are working.
    return read(workerToken).then((response) => {
      expect(response.statusCode).toBe(200)
      const groups = response.json().groups
      expect(groups.length).toBeGreaterThan(0)
      expect(groups.every((g: { enabled: boolean }) => g.enabled)).toBe(true)
    })
  })

  it('shows a worker the work groups and a customer neither', async () => {
    const workerKeys = (await read(workerToken)).json().groups.map((g: { key: string }) => g.key)
    const customerKeys = (await read(customerToken)).json().groups.map((g: { key: string }) => g.key)

    expect(workerKeys).toContain('nearby-work')
    expect(customerKeys).not.toContain('nearby-work')
    expect(customerKeys).toContain('messages')
  })

  it('carries the consequence of turning the serious ones off', async () => {
    const groups = (await read(customerToken)).json().groups
    const progress = groups.find((g: { key: string }) => g.key === 'job-progress')
    expect(progress.cost).toMatch(/arrive at your house/i)
  })

  it('refuses an anonymous read', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/notification-preferences' })
    expect(response.statusCode).toBe(401)
  })
})

describe('turning a group off', () => {
  it('stops the notifier sending that category', async () => {
    // The whole point. A 200 from the endpoint proves nothing on its own.
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)

    const before = await notifier.notify({
      userId: workerUserId, type: 'JOB_MATCH', title: 'New job', body: 'Near you.', force: true,
    })
    expect(before).toBe(true)
    push.reset()

    expect((await write(workerToken, { 'nearby-work': false })).statusCode).toBe(200)

    const after = await notifier.notify({
      userId: workerUserId, type: 'JOB_MATCH', title: 'New job', body: 'Near you.', force: true,
    })
    expect(after).toBe(false)
    expect(push.sent).toHaveLength(0)
  })

  it('leaves the other groups alone', async () => {
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)

    await write(workerToken, { 'nearby-work': false })

    const message = await notifier.notify({
      userId: workerUserId, type: 'NEW_MESSAGE', title: 'Message', body: 'Open the app.', force: true,
    })
    expect(message).toBe(true)
  })

  it('mutes every category in the group, not just the first', async () => {
    // "Jobs you are on" is six categories. Muting one of them and leaving five
    // is the state no screen can explain.
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)

    await write(workerToken, { 'job-progress': false })

    for (const type of ['JOB_CLAIMED', 'WORKER_EN_ROUTE', 'WORK_STARTED', 'PHOTOS_UPLOADED', 'DEADLINE_REMINDER', 'JOB_EXPIRING'] as const) {
      const delivered = await notifier.notify({
        userId: workerUserId, type, title: 'x', body: 'y', force: true,
      })
      expect(delivered, `${type} was still delivered`).toBe(false)
    }
  })

  it('records why it was not sent, rather than dropping it silently', async () => {
    const notifier = new Notifier(prisma, new RecordingPushSender())
    await write(workerToken, { ranks: false })
    await notifier.notify({
      userId: workerUserId, type: 'RANK_UP', title: 'Rank up', body: 'Nice.', force: true,
    })

    const record = await prisma.notification.findFirstOrThrow({ where: { type: 'RANK_UP' } })
    expect(record.sentAt).toBeNull()
    expect(record.failureReason).toMatch(/preference/i)
  })

  it('comes back on', async () => {
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)

    await write(workerToken, { 'nearby-work': false })
    await write(workerToken, { 'nearby-work': true })

    const delivered = await notifier.notify({
      userId: workerUserId, type: 'JOB_MATCH', title: 'New job', body: 'Near you.', force: true,
    })
    expect(delivered).toBe(true)
  })

  it('reflects the change in what it returns', async () => {
    const response = await write(workerToken, { ranks: false })
    const ranks = response.json().groups.find((g: { key: string }) => g.key === 'ranks')
    expect(ranks.enabled).toBe(false)

    const reread = (await read(workerToken)).json().groups
      .find((g: { key: string }) => g.key === 'ranks')
    expect(reread.enabled).toBe(false)
  })

  it('leaves unmentioned groups untouched', async () => {
    await write(workerToken, { ranks: false })
    await write(workerToken, { messages: false })

    const groups = (await read(workerToken)).json().groups
    expect(groups.find((g: { key: string }) => g.key === 'ranks').enabled).toBe(false)
    expect(groups.find((g: { key: string }) => g.key === 'messages').enabled).toBe(false)
  })

  it('ignores a group key it does not recognise rather than refusing the save', async () => {
    // An older build sending a group we have since renamed should still get to
    // save the switches it does know about.
    const response = await write(workerToken, { ranks: false, 'something-we-removed': true })
    expect(response.statusCode).toBe(200)
    expect((await read(workerToken)).json().groups
      .find((g: { key: string }) => g.key === 'ranks').enabled).toBe(false)
  })

  it('cannot change somebody else\'s preferences', async () => {
    await write(customerToken, { messages: false })
    // The worker's own settings are untouched by the customer's save.
    const groups = (await read(workerToken)).json().groups
    expect(groups.find((g: { key: string }) => g.key === 'messages').enabled).toBe(true)
  })
})
