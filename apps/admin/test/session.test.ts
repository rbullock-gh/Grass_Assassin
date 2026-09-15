import { describe, expect, it } from 'vitest'
import { issueSession, readSession } from '../src/lib/session'

const SECRET = 'a-test-signing-secret-at-least-32-characters'
const USER = 'clx0admin000000000000000'
const OTHER = 'clx0other000000000000000'

describe('admin sessions', () => {
  it('returns the administrator a token was issued for', async () => {
    expect(await readSession(SECRET, await issueSession(SECRET, USER))).toBe(USER)
  })

  it('rejects a token signed with a different secret', async () => {
    // The whole point: possession of the cookie format is not possession of a
    // session. Otherwise anyone could mint one.
    const forged = await issueSession('some-other-secret-at-least-32-characters-x', USER)
    expect(await readSession(SECRET, forged)).toBeNull()
  })

  it('will not let one administrator be swapped for another', async () => {
    // The reason the user id lives inside the signed payload. If it were
    // appended alongside the signature, this substitution would succeed and
    // every audit entry would name whoever the attacker chose.
    const token = await issueSession(SECRET, USER)
    const [, expiresAt, nonce, signature] = token.split('.')
    const swapped = `${OTHER}.${expiresAt}.${nonce}.${signature}`
    expect(await readSession(SECRET, swapped)).toBeNull()
  })

  it('rejects a tampered expiry', async () => {
    // The attack this stops: take a valid expired token and push the date out.
    const token = await issueSession(SECRET, USER)
    const [userId, , nonce, signature] = token.split('.')
    const extended = `${userId}.${Date.now() + 999_999_999}.${nonce}.${signature}`
    expect(await readSession(SECRET, extended)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const issued = await issueSession(SECRET, USER, new Date('2026-01-01T00:00:00Z'))
    expect(await readSession(SECRET, issued, new Date('2026-06-01T00:00:00Z'))).toBeNull()
  })

  it('expires twelve hours out, not at some accidental default', async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const token = await issueSession(SECRET, USER, now)
    const justBefore = new Date(now.getTime() + 12 * 3_600_000 - 1000)
    const justAfter = new Date(now.getTime() + 12 * 3_600_000 + 1000)
    expect(await readSession(SECRET, token, justBefore)).toBe(USER)
    expect(await readSession(SECRET, token, justAfter)).toBeNull()
  })

  it('rejects nothing, garbage, and the wrong shape', async () => {
    for (const token of [undefined, '', 'nonsense', 'a.b', 'a.b.c', 'a.b.c.d.e', '...']) {
      expect(await readSession(SECRET, token), String(token)).toBeNull()
    }
  })

  it('issues a different token each time, for the same administrator', async () => {
    // A fixed token is a password that never rotates and leaks in every log.
    expect(await issueSession(SECRET, USER)).not.toBe(await issueSession(SECRET, USER))
  })

  it('refuses to issue for an id containing the field separator', async () => {
    // A dot in the id would let it consume the expiry field and make the token
    // parse as something other than what was signed.
    await expect(issueSession(SECRET, 'ad.min')).rejects.toThrow(/dot/)
  })
})
