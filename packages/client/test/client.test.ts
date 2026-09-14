import { describe, it, expect, vi } from 'vitest'
import { GrassAssassinClient, MemoryTokenStore, ApiError } from '../src/client.js'

/**
 * The client is tested against a scripted fetch rather than a live server.
 * What matters here is the client's own behaviour — token refresh collapsing,
 * error mapping, query serialisation — not the API, which has its own suite.
 */

function scriptedFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  let index = 0
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString()
    calls.push({ url, init })
    const handler = handlers[Math.min(index, handlers.length - 1)]
    index += 1
    if (!handler) throw new Error(`No handler for call ${index}: ${url}`)
    return handler(url, init)
  }) as typeof fetch
  return { impl, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('request building', () => {
  it('sends the bearer token when one is stored', async () => {
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' })
    const { impl, calls } = scriptedFetch([() => json({ id: 'u1' })])

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl })
    await client.me()

    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer access-1')
  })

  it('omits the authorization header when signed out', async () => {
    const { impl, calls } = scriptedFetch([() => json({ categories: [] })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })
    await client.categories()

    const headers = calls[0]!.init!.headers as Record<string, string>
    expect(headers['authorization']).toBeUndefined()
  })

  it('serialises query parameters, repeating arrays', async () => {
    const { impl, calls } = scriptedFetch([() => json({ jobs: [], radiusMilesApplied: 10 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    await client.searchJobs({
      center: { lat: 36.16, lng: -86.78 },
      radiusMiles: 12,
      categoryIds: ['a', 'b'],
      sort: 'PAY_DESC',
    })

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/jobs/search')
    expect(url.searchParams.get('lat')).toBe('36.16')
    expect(url.searchParams.get('radiusMiles')).toBe('12')
    expect(url.searchParams.getAll('categoryIds')).toEqual(['a', 'b'])
    expect(url.searchParams.get('sort')).toBe('PAY_DESC')
  })

  it('omits undefined query parameters entirely', async () => {
    const { impl, calls } = scriptedFetch([() => json({ jobs: [], radiusMilesApplied: 10 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    await client.searchJobs({ center: { lat: 1, lng: 2 } })

    const url = new URL(calls[0]!.url)
    expect(url.searchParams.has('minPayoutCents')).toBe(false)
    expect(url.searchParams.has('difficulty')).toBe(false)
  })

  it('handles a 204 without trying to parse a body', async () => {
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'a', refreshToken: 'r' })
    const { impl } = scriptedFetch([() => new Response(null, { status: 204 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl })

    await expect(client.logout()).resolves.toBeUndefined()
  })
})

describe('error mapping', () => {
  it('turns an API error body into a typed ApiError', async () => {
    const { impl } = scriptedFetch([
      () => json({ error: { code: 'OUTSIDE_SERVICE_AREA', message: 'Not in your area yet' } }, 409),
    ])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    const error = await client.categories().catch((e: unknown) => e as ApiError)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('OUTSIDE_SERVICE_AREA')
    expect((error as ApiError).status).toBe(409)
  })

  it('marks 5xx and 429 as retryable, and 4xx as not', async () => {
    const make = (status: number) => new ApiError('X', 'x', status)
    expect(make(500).isRetryable).toBe(true)
    expect(make(503).isRetryable).toBe(true)
    expect(make(429).isRetryable).toBe(true)
    expect(make(400).isRetryable).toBe(false)
    expect(make(409).isRetryable).toBe(false)
  })

  it('copes with an error response that has no JSON body', async () => {
    const { impl } = scriptedFetch([() => new Response('', { status: 502 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    const error = await client.categories().catch((e: unknown) => e as ApiError)
    expect((error as ApiError).status).toBe(502)
    expect((error as ApiError).code).toBe('UNKNOWN')
  })
})

describe('token refresh', () => {
  it('refreshes once on a 401 and retries the original request', async () => {
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'stale', refreshToken: 'refresh-1' })

    const { impl, calls } = scriptedFetch([
      () => json({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401),
      () => json({ accessToken: 'fresh', refreshToken: 'refresh-2', expiresIn: 900 }),
      () => json({ id: 'u1', email: 'a@b.c' }),
    ])

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl })
    const me = await client.me()

    expect(me.id).toBe('u1')
    expect(calls).toHaveLength(3)
    expect(calls[1]!.url).toContain('/v1/auth/refresh')
    // The retry carries the new token, not the stale one.
    expect((calls[2]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer fresh')
    expect(tokens.getAccessToken()).toBe('fresh')
    expect(tokens.getRefreshToken()).toBe('refresh-2')
  })

  it('does not retry forever when the retry also 401s', async () => {
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'stale', refreshToken: 'refresh-1' })
    const onAuthExpired = vi.fn()

    const { impl, calls } = scriptedFetch([
      () => json({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401),
      () => json({ accessToken: 'fresh', refreshToken: 'refresh-2', expiresIn: 900 }),
      () => json({ error: { code: 'UNAUTHORIZED', message: 'still bad' } }, 401),
    ])

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl, onAuthExpired })
    await expect(client.me()).rejects.toThrow(ApiError)

    // Exactly three calls: original, refresh, one retry. No loop.
    expect(calls).toHaveLength(3)
  })

  it('COLLAPSES concurrent refreshes into one', async () => {
    // Five screens loading at once all get a 401. If each refreshed
    // independently, the refresh token would rotate five times and the
    // server's reuse detection would sign the user out for doing nothing wrong.
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'stale', refreshToken: 'refresh-1' })

    let refreshCalls = 0
    const impl = (async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/auth/refresh')) {
        refreshCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 15))
        return json({ accessToken: 'fresh', refreshToken: 'refresh-2', expiresIn: 900 })
      }
      const token = tokens.getAccessToken()
      if (token === 'stale') return json({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401)
      return json({ ok: true })
    }) as typeof fetch

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl })

    await Promise.all([
      client.categories(), client.categories(), client.categories(),
      client.categories(), client.categories(),
    ])

    expect(refreshCalls, 'the refresh token must rotate once, not five times').toBe(1)
  })

  it('clears tokens and signals expiry when the refresh itself fails', async () => {
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'stale', refreshToken: 'dead' })
    const onAuthExpired = vi.fn()

    const { impl } = scriptedFetch([
      () => json({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401),
      () => json({ error: { code: 'UNAUTHORIZED', message: 'reuse detected' } }, 401),
    ])

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl, onAuthExpired })
    await expect(client.me()).rejects.toThrow(ApiError)

    expect(onAuthExpired).toHaveBeenCalledOnce()
    expect(tokens.getAccessToken()).toBeNull()
  })

  it('does not attempt a refresh when there is no refresh token', async () => {
    const { impl, calls } = scriptedFetch([
      () => json({ error: { code: 'UNAUTHORIZED', message: 'no token' } }, 401),
    ])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    await expect(client.me()).rejects.toThrow(ApiError)
    expect(calls).toHaveLength(1)
  })
})

describe('claiming', () => {
  it('resolves rather than throws when the worker loses the race', async () => {
    // Losing is the most common non-happy outcome in the product. Making it an
    // exception would push every call site into a try/catch.
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'a', refreshToken: 'r' })
    const { impl } = scriptedFetch([
      () => json({ outcome: 'LOST', jobId: 'j1', reason: 'ALREADY_CLAIMED', message: 'Another pro claimed this job first.' }),
    ])

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl })
    const result = await client.claimJob('j1')

    expect(result.outcome).toBe('LOST')
    if (result.outcome === 'LOST') expect(result.reason).toBe('ALREADY_CLAIMED')
  })

  it('sends the worker location when provided', async () => {
    const tokens = new MemoryTokenStore()
    tokens.setTokens({ accessToken: 'a', refreshToken: 'r' })
    const { impl, calls } = scriptedFetch([
      () => json({ outcome: 'WON', jobId: 'j1', claimId: 'c1', expiresAt: '2026-01-01T00:00:00Z' }),
    ])

    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', tokens, fetchImpl: impl })
    await client.claimJob('j1', { lat: 36.16, lng: -86.78 })

    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body.workerLocation).toEqual({ lat: 36.16, lng: -86.78 })
  })
})

describe('base url handling', () => {
  it('tolerates a trailing slash', async () => {
    const { impl, calls } = scriptedFetch([() => json({ categories: [] })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test/', fetchImpl: impl })
    await client.categories()
    expect(calls[0]!.url).toBe('https://api.test/v1/categories')
  })
})

describe('timezone', () => {
  it('sends the device timezone offset so "due today" means the user\'s today', async () => {
    const { impl, calls } = scriptedFetch([() => json({ jobs: [], radiusMilesApplied: 10 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    await client.searchJobs({ center: { lat: 36.16, lng: -86.78 }, dueToday: true })

    const url = new URL(calls[0]!.url)
    expect(url.searchParams.has('tzOffsetMinutes')).toBe(true)
    expect(Number(url.searchParams.get('tzOffsetMinutes'))).toBe(new Date().getTimezoneOffset())
  })

  it('lets a caller override the offset', async () => {
    const { impl, calls } = scriptedFetch([() => json({ jobs: [], radiusMilesApplied: 10 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    await client.searchJobs({ center: { lat: 36.16, lng: -86.78 }, tzOffsetMinutes: 600 })

    expect(new URL(calls[0]!.url).searchParams.get('tzOffsetMinutes')).toBe('600')
  })

  it('sends offset 0 rather than omitting it for a UTC device', async () => {
    // `?? ` not `|| ` — an offset of 0 is a real value, and `||` would replace
    // it with the device default, which is the same thing here but would be a
    // latent bug the moment the default changed.
    const { impl, calls } = scriptedFetch([() => json({ jobs: [], radiusMilesApplied: 10 })])
    const client = new GrassAssassinClient({ baseUrl: 'https://api.test', fetchImpl: impl })

    await client.searchJobs({ center: { lat: 36.16, lng: -86.78 }, tzOffsetMinutes: 0 })

    expect(new URL(calls[0]!.url).searchParams.get('tzOffsetMinutes')).toBe('0')
  })
})
