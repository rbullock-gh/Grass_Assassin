import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { prisma, resetDatabase, createCustomer } from '../../../test/factories.js'
import { ExpoPushSender, EXPO_CHUNK_SIZE } from './expo-push.js'
import type { PushMessage } from './notifier.js'

/**
 * The Expo adapter, against a fake Expo.
 *
 * Everything worth testing here is a failure mode. The happy path is one POST;
 * what decides whether push keeps working six months in is what happens to a
 * token after somebody deletes the app, and whether an outage at Expo can take
 * a claim down with it.
 */

interface Call { url: string; body: unknown; headers: Record<string, string> }

/** Stands in for Expo. Records calls and answers with whatever is queued. */
class FakeExpo {
  readonly calls: Call[] = []
  ticketsFor: (messages: PushMessage[]) => unknown = (messages) =>
    messages.map((_, i) => ({ status: 'ok', id: `ticket-${i}` }))
  receiptsFor: (ids: string[]) => unknown = (ids) =>
    Object.fromEntries(ids.map((id) => [id, { status: 'ok' }]))
  failWith: number | 'network' | null = null

  fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body))
    this.calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> })

    if (this.failWith === 'network') throw new Error('socket hang up')
    if (typeof this.failWith === 'number') {
      return new Response('nope', { status: this.failWith })
    }

    const data = url.includes('getReceipts')
      ? this.receiptsFor(body.ids as string[])
      : this.ticketsFor(body as PushMessage[])
    return new Response(JSON.stringify({ data }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
}

const message = (to: string): PushMessage => ({ to, title: 'Job nearby', body: '$60, 1.2 mi' })
const token = (n: number) => `ExponentPushToken[${String(n).padStart(22, 'x')}]`

let expo: FakeExpo

beforeAll(async () => { await prisma.$connect() })
afterAll(async () => { await prisma.$disconnect() })
beforeEach(async () => {
  await resetDatabase()
  expo = new FakeExpo()
})

describe('sending', () => {
  it('posts the messages and counts what Expo accepted', async () => {
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    const result = await sender.send([message(token(1)), message(token(2))])

    expect(result).toEqual({ sent: 2, failed: 0 })
    expect(expo.calls).toHaveLength(1)
    expect(expo.calls[0]!.body).toHaveLength(2)
  })

  it('sends nothing, and calls nothing, for an empty list', async () => {
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    expect(await sender.send([])).toEqual({ sent: 0, failed: 0 })
    expect(expo.calls).toHaveLength(0)
  })

  it('splits past Expo\'s batch limit instead of failing the whole send', async () => {
    // Expo rejects a request carrying more than 100 messages — the entire
    // batch, not the overflow. A city-wide job match can easily exceed that.
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    const many = Array.from({ length: EXPO_CHUNK_SIZE + 30 }, (_, i) => message(token(i)))

    const result = await sender.send(many)

    expect(result.sent).toBe(EXPO_CHUNK_SIZE + 30)
    expect(expo.calls).toHaveLength(2)
    expect(expo.calls[0]!.body).toHaveLength(EXPO_CHUNK_SIZE)
    expect(expo.calls[1]!.body).toHaveLength(30)
  })

  it('sends the access token when it has one, and omits the header when it does not', async () => {
    await new ExpoPushSender({ fetchImpl: expo.fetch, accessToken: 'secret' }).send([message(token(1))])
    expect(expo.calls[0]!.headers.authorization).toBe('Bearer secret')

    const bare = new FakeExpo()
    await new ExpoPushSender({ fetchImpl: bare.fetch }).send([message(token(1))])
    expect(bare.calls[0]!.headers.authorization).toBeUndefined()
  })
})

describe('when Expo is having a bad day', () => {
  it('reports failures rather than throwing at the caller', async () => {
    // These run inside the job lifecycle: a worker claims, a customer gets
    // told. If a push outage threw, the claim would fail with it.
    expo.failWith = 'network'
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })

    const result = await sender.send([message(token(1)), message(token(2))])
    expect(result).toEqual({ sent: 0, failed: 2 })
  })

  it('treats a 500 the same way', async () => {
    expo.failWith = 500
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    expect(await sender.send([message(token(1))])).toEqual({ sent: 0, failed: 1 })
  })

  it('keeps the tokens when the failure was transport, not the token', async () => {
    const user = await createCustomer()
    await prisma.device.create({
      data: { userId: user.id, pushToken: token(1), platform: 'ios' },
    })

    expo.failWith = 'network'
    await new ExpoPushSender({ fetchImpl: expo.fetch, db: prisma }).send([message(token(1))])

    // Deleting a device because Expo blipped silently unsubscribes a real
    // person, and they have no way to know they need to turn it back on.
    expect(await prisma.device.count()).toBe(1)
  })
})

describe('pruning devices that will never receive again', () => {
  it('deletes a token Expo rejects as DeviceNotRegistered', async () => {
    const user = await createCustomer()
    await prisma.device.createMany({
      data: [
        { userId: user.id, pushToken: token(1), platform: 'ios' },
        { userId: user.id, pushToken: token(2), platform: 'android' },
      ],
    })

    expo.ticketsFor = (messages) => messages.map((m) =>
      m.to === token(1)
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok', id: 'ticket-ok' })

    const result = await new ExpoPushSender({ fetchImpl: expo.fetch, db: prisma })
      .send([message(token(1)), message(token(2))])

    expect(result).toEqual({ sent: 1, failed: 1 })
    const left = await prisma.device.findMany({ select: { pushToken: true } })
    expect(left.map((d) => d.pushToken)).toEqual([token(2)])
  })

  it('keeps a token whose error was transient', async () => {
    const user = await createCustomer()
    await prisma.device.create({ data: { userId: user.id, pushToken: token(1), platform: 'ios' } })

    expo.ticketsFor = () => [
      { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
    ]

    await new ExpoPushSender({ fetchImpl: expo.fetch, db: prisma }).send([message(token(1))])
    expect(await prisma.device.count()).toBe(1)
  })

  it('prunes from the RECEIPT, which is where most dead tokens surface', async () => {
    // A ticket only says Expo accepted the message. Apple and Google answer
    // seconds later, in the receipt. Without checking receipts a reinstalled
    // phone stays in the table forever and every send looks successful.
    const user = await createCustomer()
    await prisma.device.create({ data: { userId: user.id, pushToken: token(7), platform: 'ios' } })

    const sender = new ExpoPushSender({ fetchImpl: expo.fetch, db: prisma })
    expo.ticketsFor = () => [{ status: 'ok', id: 'ticket-7' }]
    expect(await sender.send([message(token(7))])).toEqual({ sent: 1, failed: 0 })
    expect(await prisma.device.count()).toBe(1)

    expo.receiptsFor = () => ({
      'ticket-7': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    })
    const swept = await sender.collectReceipts()

    expect(swept).toEqual({ ok: 0, failed: 1, pruned: 1 })
    expect(await prisma.device.count()).toBe(0)
  })

  it('waits rather than guessing when a receipt is not ready yet', async () => {
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    expo.ticketsFor = () => [{ status: 'ok', id: 'ticket-slow' }]
    await sender.send([message(token(1))])

    expo.receiptsFor = () => ({})
    expect(await sender.collectReceipts()).toEqual({ ok: 0, failed: 0, pruned: 0 })

    // Still pending, so the next sweep asks again rather than losing it.
    expo.receiptsFor = (ids) => Object.fromEntries(ids.map((id) => [id, { status: 'ok' }]))
    expect(await sender.collectReceipts()).toEqual({ ok: 1, failed: 0, pruned: 0 })
  })

  it('asks for nothing when there is nothing outstanding', async () => {
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    expect(await sender.collectReceipts()).toEqual({ ok: 0, failed: 0, pruned: 0 })
    expect(expo.calls).toHaveLength(0)
  })

  it('keeps receipts pending when the receipt endpoint itself is down', async () => {
    const sender = new ExpoPushSender({ fetchImpl: expo.fetch })
    expo.ticketsFor = () => [{ status: 'ok', id: 'ticket-1' }]
    await sender.send([message(token(1))])

    expo.failWith = 500
    expect(await sender.collectReceipts()).toEqual({ ok: 0, failed: 0, pruned: 0 })

    expo.failWith = null
    expect(await sender.collectReceipts()).toEqual({ ok: 1, failed: 0, pruned: 0 })
  })
})
