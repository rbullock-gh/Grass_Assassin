import { describe, expect, it } from 'vitest'
import { issueSession, verifySession, passwordMatches } from '../src/lib/session'

const SECRET = 'a-test-signing-secret-at-least-32-characters'

describe('admin sessions', async () => {
  it('accepts a token it just issued', async () => {
    expect(await verifySession(SECRET, await issueSession(SECRET))).toBe(true)
  })

  it('rejects a token signed with a different secret', async () => {
    // The whole point: possession of the cookie format is not possession of a
    // session. Otherwise anyone could mint one.
    const forged = await issueSession('some-other-secret-at-least-32-characters-x')
    expect(await verifySession(SECRET, forged)).toBe(false)
  })

  it('rejects a tampered expiry', async () => {
    // The attack this stops: take a valid expired token and push the date out.
    const token = await issueSession(SECRET)
    const [, nonce, signature] = token.split('.')
    const extended = `${Date.now() + 999_999_999}.${nonce}.${signature}`
    expect(await verifySession(SECRET, extended)).toBe(false)
  })

  it('rejects an expired token', async () => {
    const issued = await issueSession(SECRET, new Date('2026-01-01T00:00:00Z'))
    expect(await verifySession(SECRET, issued, new Date('2026-06-01T00:00:00Z'))).toBe(false)
  })

  it('rejects nothing, garbage, and the wrong shape', async () => {
    for (const token of [undefined, '', 'nonsense', 'a.b', 'a.b.c.d']) {
      expect(await verifySession(SECRET, token), String(token)).toBe(false)
    }
  })

  it('issues a different token each time', async () => {
    // A fixed token is a password that never rotates and leaks in every log.
    expect(await issueSession(SECRET)).not.toBe(await issueSession(SECRET))
  })
})

describe('password comparison', async () => {
  it('accepts the right password', async () => {
    expect(await passwordMatches('correct horse battery', 'correct horse battery')).toBe(true)
  })

  it('rejects a wrong one, including a prefix of the right one', async () => {
    expect(await passwordMatches('correct horse battery', 'correct horse')).toBe(false)
    expect(await passwordMatches('correct horse battery', 'correct horse batteryy')).toBe(false)
    expect(await passwordMatches('correct horse battery', '')).toBe(false)
  })

  it('compares hashes of equal length, so timing does not leak the length', async () => {
    // Comparing the raw strings would return early on the first wrong byte and
    // on any length mismatch, which is measurable.
    expect(await passwordMatches('short', 'a-much-much-longer-password-here')).toBe(false)
  })
})
