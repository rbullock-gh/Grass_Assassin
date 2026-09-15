import { describe, it, expect } from 'vitest'
import { ResendMailProvider } from './resend-provider.js'
import { MailDeliveryError, type MailMessage } from './provider.js'

/**
 * The Resend adapter, against a stubbed fetch.
 *
 * WHAT THIS DOES NOT PROVE: that Resend accepts these requests. There is no API
 * key in this environment and no live call is made anywhere in this suite. What
 * it pins is the part that is ours — the request we build, when we retry, when
 * we give up, and that a retry cannot send twice.
 */

const MESSAGE: MailMessage = {
  to: 'someone@example.com',
  subject: 'Reset your GrassAssassin password',
  text: 'a link',
  category: 'password-reset',
}

function stubFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('stub ran out of responses')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { impl, calls }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}

const noSleep = async () => undefined

function provider(fetchImpl: typeof fetch, maxAttempts = 3) {
  return new ResendMailProvider({
    apiKey: 'test-key', from: 'GrassAssassin <no-reply@example.com>',
    fetchImpl, sleep: noSleep, maxAttempts,
  })
}

describe('the request it builds', () => {
  it('posts the message with the API key and the from address', async () => {
    const { impl, calls } = stubFetch([json(200, { id: 'msg_1' })])
    const result = await provider(impl).send(MESSAGE)

    expect(result).toEqual({ messageId: 'msg_1', accepted: true })
    expect(calls[0]!.url).toBe('https://api.resend.com/emails')

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')

    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.from).toBe('GrassAssassin <no-reply@example.com>')
    expect(body.to).toEqual(['someone@example.com'])
    expect(body.text).toBe('a link')
    expect(body.tags).toEqual([{ name: 'category', value: 'password-reset' }])
  })

  it('omits html rather than sending an empty one', async () => {
    const { impl, calls } = stubFetch([json(200, { id: 'msg_1' })])
    await provider(impl).send(MESSAGE)
    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty('html')
  })
})

describe('retrying', () => {
  it('retries a 429 and succeeds', async () => {
    const { impl, calls } = stubFetch([
      json(429, { message: 'Too many requests' }),
      json(200, { id: 'msg_2' }),
    ])
    const result = await provider(impl).send(MESSAGE)
    expect(result.accepted).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('reuses one idempotency key across attempts, so a retry cannot send twice', async () => {
    const { impl, calls } = stubFetch([
      json(500, { message: 'upstream' }),
      json(200, { id: 'msg_3' }),
    ])
    await provider(impl).send(MESSAGE)

    const first = (calls[0]!.init.headers as Record<string, string>)['idempotency-key']
    const second = (calls[1]!.init.headers as Record<string, string>)['idempotency-key']
    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('uses a different key for a different send, so two real sends are not collapsed', async () => {
    // A content-derived key is the tempting version and would suppress a
    // genuinely repeated message for the 24 hours the provider honours it.
    const { impl, calls } = stubFetch([json(200, { id: 'a' }), json(200, { id: 'b' })])
    const mail = provider(impl)
    await mail.send(MESSAGE)
    await mail.send(MESSAGE)

    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key'])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('retries a transport failure, which says nothing about whether it arrived', async () => {
    const { impl, calls } = stubFetch([new Error('ECONNRESET'), json(200, { id: 'msg_4' })])
    await provider(impl).send(MESSAGE)
    expect(calls).toHaveLength(2)
  })

  it('does NOT retry a 422 — a rejected sender domain does not heal', async () => {
    const { impl, calls } = stubFetch([json(422, { message: 'domain not verified' })])
    await expect(provider(impl).send(MESSAGE)).rejects.toThrow(MailDeliveryError)
    expect(calls).toHaveLength(1)
  })

  it('does NOT retry a 401 — a bad key is not a temporary condition', async () => {
    const { impl, calls } = stubFetch([json(401, { message: 'invalid api key' })])
    await expect(provider(impl).send(MESSAGE)).rejects.toThrow(/401/)
    expect(calls).toHaveLength(1)
  })

  it('gives up after the attempt limit', async () => {
    const { impl, calls } = stubFetch([
      json(500, {}), json(500, {}), json(500, {}),
    ])
    await expect(provider(impl).send(MESSAGE)).rejects.toThrow(MailDeliveryError)
    expect(calls).toHaveLength(3)
  })

  it('waits as long as Retry-After says, not its own shorter guess', async () => {
    const waits: number[] = []
    const { impl } = stubFetch([
      json(429, {}, { 'retry-after': '7' }),
      json(200, { id: 'msg_5' }),
    ])
    const mail = new ResendMailProvider({
      apiKey: 'k', from: 'a@example.com', fetchImpl: impl,
      sleep: async (ms) => { waits.push(ms) },
    })
    await mail.send(MESSAGE)
    expect(waits).toEqual([7000])
  })

  it('falls back to its own backoff when there is no Retry-After', async () => {
    const waits: number[] = []
    const { impl } = stubFetch([json(500, {}), json(500, {}), json(200, { id: 'x' })])
    const mail = new ResendMailProvider({
      apiKey: 'k', from: 'a@example.com', fetchImpl: impl,
      sleep: async (ms) => { waits.push(ms) },
    })
    await mail.send(MESSAGE)
    expect(waits).toEqual([400, 800])
  })
})

describe('what it reports', () => {
  it('carries the status onto the error, so a caller can tell 429 from 422', async () => {
    const { impl } = stubFetch([json(422, { message: 'bad' })])
    await provider(impl).send(MESSAGE).catch((error: MailDeliveryError) => {
      expect(error.status).toBe(422)
      expect(error.providerName).toBe('resend')
    })
  })

  it('accepts a success with no id rather than treating it as a failure', async () => {
    const { impl } = stubFetch([json(200, {})])
    expect(await provider(impl).send(MESSAGE)).toEqual({ messageId: null, accepted: true })
  })

  it('does not choke on a success whose body is not JSON', async () => {
    const { impl } = stubFetch([new Response('OK', { status: 200 })])
    expect((await provider(impl).send(MESSAGE)).accepted).toBe(true)
  })
})
