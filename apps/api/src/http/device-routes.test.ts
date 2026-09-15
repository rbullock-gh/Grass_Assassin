import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma, resetDatabase, createCategory, createCustomer, createWorker } from '../../test/factories.js'
import { buildServer } from './server.js'
import { FakePaymentProvider } from '../modules/payments/fake-provider.js'
import { Notifier, RecordingPushSender } from '../modules/notifications/notifier.js'

/**
 * Registering a phone for push.
 *
 * Small surface, but the notifier is useless without it — before these routes
 * existed the devices table was never written to, so every notification the
 * product sends was recorded with "No registered device" and dropped.
 */
const provider = new FakePaymentProvider()
let app: FastifyInstance

let customerToken: string
let customerId: string
let workerToken: string
let workerUserId: string

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]'

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
    userId: user.id,
    roles: user.roles,
    secret: 'test-access-secret-at-least-32-characters-long',
    ttlSeconds: 900,
  })
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

const register = (token: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/devices', headers: auth(token), payload: body })

describe('registering a device', () => {
  it('stores the token so the notifier can find it', async () => {
    const response = await register(customerToken, { pushToken: TOKEN_A, platform: 'ios' })
    expect(response.statusCode).toBe(200)

    const device = await prisma.device.findUnique({ where: { pushToken: TOKEN_A } })
    expect(device?.userId).toBe(customerId)
    expect(device?.platform).toBe('ios')
  })

  it('is idempotent, because the app registers on every launch', async () => {
    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios', appVersion: '1.0.0' })
    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios', appVersion: '1.1.0' })

    const devices = await prisma.device.findMany({ where: { userId: customerId } })
    expect(devices).toHaveLength(1)
    expect(devices[0]!.appVersion).toBe('1.1.0')
  })

  it('re-points a token at whoever is signed in now', async () => {
    // One phone, two people: a shared device, or a sale, or simply signing out.
    // If the row kept its first owner, the second person's phone would keep
    // buzzing with the first person's job alerts — which carry addresses.
    await register(customerToken, { pushToken: TOKEN_A, platform: 'android' })
    await register(workerToken, { pushToken: TOKEN_A, platform: 'android' })

    const device = await prisma.device.findUnique({ where: { pushToken: TOKEN_A } })
    expect(device?.userId).toBe(workerUserId)
    expect(await prisma.device.count()).toBe(1)
  })

  it('keeps a second phone belonging to the same person', async () => {
    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios' })
    await register(customerToken, { pushToken: TOKEN_B, platform: 'android' })
    expect(await prisma.device.count({ where: { userId: customerId } })).toBe(2)
  })

  it('refuses something that is not an Expo push token', async () => {
    const response = await register(customerToken, { pushToken: 'not-a-token', platform: 'ios' })
    expect(response.statusCode).toBe(400)
    expect(await prisma.device.count()).toBe(0)
  })

  it('refuses an anonymous registration', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/devices', payload: { pushToken: TOKEN_A, platform: 'ios' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('records the timezone the phone reported', async () => {
    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios', tzOffsetMinutes: 0 })
    const device = await prisma.device.findUnique({ where: { pushToken: TOKEN_A } })
    expect(device?.tzOffsetMinutes).toBe(0)
  })
})

describe('signing out', () => {
  it('removes the token so the phone stops receiving', async () => {
    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios' })
    const response = await app.inject({
      method: 'DELETE', url: '/v1/devices', headers: auth(customerToken),
      payload: { pushToken: TOKEN_A },
    })
    expect(response.statusCode).toBe(204)
    expect(await prisma.device.count()).toBe(0)
  })

  it('will not let one person deregister another person\'s phone', async () => {
    // A push token is a long string that ends up in logs and crash reports.
    // If quoting one were enough to delete it, silencing a competitor's job
    // alerts would be a one-line curl.
    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios' })
    const response = await app.inject({
      method: 'DELETE', url: '/v1/devices', headers: auth(workerToken),
      payload: { pushToken: TOKEN_A },
    })
    expect(response.statusCode).toBe(204)
    expect(await prisma.device.count()).toBe(1)
  })
})

describe('what the notifier does with a registered device', () => {
  it('delivers once a device exists, having refused before', async () => {
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)

    const before = await notifier.notify({
      userId: customerId, type: 'JOB_CLAIMED', title: 'Claimed', body: 'A pro took your job.',
    })
    expect(before).toBe(false)
    expect(push.sent).toHaveLength(0)

    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios' })

    const after = await notifier.notify({
      userId: customerId, type: 'JOB_CLAIMED', title: 'Claimed', body: 'A pro took your job.',
    })
    expect(after).toBe(true)
    expect(push.sent.map((m) => m.to)).toEqual([TOKEN_A])
  })

  it('uses the timezone the device reported, not the launch market', async () => {
    // 02:00 UTC is 20:00 in US Central (awake) and 03:00 in Berlin (asleep).
    // A JOB_MATCH is exactly the kind of push that must not arrive at 3am.
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)
    const at2amBerlin = new Date('2026-07-01T01:00:00Z')

    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios', tzOffsetMinutes: -60 })

    const delivered = await notifier.notify({
      userId: customerId, type: 'JOB_MATCH', title: 'New job', body: 'Near you.',
      now: at2amBerlin,
    })

    expect(delivered).toBe(false)
    const record = await prisma.notification.findFirstOrThrow({ where: { userId: customerId } })
    expect(record.failureReason).toMatch(/quiet hours/i)
  })

  it('still delivers to that same person during their own evening', async () => {
    const push = new RecordingPushSender()
    const notifier = new Notifier(prisma, push)
    // 16:00 UTC is 18:00 in Berlin — inside waking hours, outside quiet hours.
    const at6pmBerlin = new Date('2026-07-01T16:00:00Z')

    await register(customerToken, { pushToken: TOKEN_A, platform: 'ios', tzOffsetMinutes: -60 })

    const delivered = await notifier.notify({
      userId: customerId, type: 'JOB_MATCH', title: 'New job', body: 'Near you.',
      now: at6pmBerlin,
    })
    expect(delivered).toBe(true)
  })
})
