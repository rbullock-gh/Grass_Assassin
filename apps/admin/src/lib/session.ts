/**
 * Admin sessions.
 *
 * This dashboard shipped with no authentication, justified as "a staff tool on
 * a trusted network". That was defensible while every page was read-only. It
 * stopped being defensible the moment it could change the platform commission
 * and resolve disputes: anyone who could reach the port could move money.
 *
 * The first fix was a single shared password. That closed the door, but it
 * could not say WHO walked through it — and the next thing this dashboard has
 * to do is record which administrator resolved a dispute and why. An audit
 * trail whose actor column reads "somebody who knew the password" is not an
 * audit trail. So a session now identifies a real user account, which can also
 * be revoked, suspended, and rotated one person at a time.
 *
 * The cookie is a signed assertion of identity, not a bearer of authority:
 * it says "this is user X", and every consequential path re-reads that user
 * from the database (see requireAdminUser) so a revoked administrator loses
 * access at their next request rather than at their cookie's expiry.
 *
 * Built on Web Crypto rather than node:crypto because verification runs in
 * middleware, which Next executes on the Edge runtime where node builtins do
 * not exist. Password hashing is argon2 and deliberately does NOT live here —
 * it is a native module and runs only in Node-side code.
 */

const COOKIE = 'ga_admin'
const SESSION_HOURS = 12

/**
 * Reads the signing secret, refusing to run half-secured.
 *
 * A missing secret in production is a fatal misconfiguration, not a reason to
 * fall back to open access — "defaults to unlocked" is the failure mode that
 * puts an unauthenticated money surface on the internet.
 */
export function adminSecret(): string | null {
  const secret = process.env.ADMIN_SESSION_SECRET

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ADMIN_SESSION_SECRET is required. The admin dashboard can change fees and resolve ' +
        'disputes; it must not run unauthenticated.',
      )
    }
    return null
  }
  if (secret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters')
  }
  return secret
}

export function sessionCookieName(): string {
  return COOKIE
}

export function sessionMaxAgeSeconds(): number {
  return SESSION_HOURS * 3600
}

/**
 * Issues a session naming the administrator it belongs to.
 *
 * The user id is inside the signed payload rather than alongside it, so it
 * cannot be swapped for another administrator's id without invalidating the
 * signature. That is the whole point of carrying identity in the cookie.
 */
export async function issueSession(
  secret: string,
  userId: string,
  now = new Date(),
): Promise<string> {
  if (userId.includes('.')) throw new Error('User id must not contain a dot')
  const expiresAt = now.getTime() + SESSION_HOURS * 3_600_000
  const nonce = randomHex(8)
  const payload = `${userId}.${expiresAt}.${nonce}`
  return `${payload}.${await sign(secret, payload)}`
}

/**
 * Returns the administrator's user id, or null if the token is not trustworthy.
 *
 * Returning the id rather than a boolean is what lets callers act as a person.
 * It is still only an assertion of identity — see the note at the top about
 * re-reading the user before doing anything that matters.
 */
export async function readSession(
  secret: string,
  token: string | undefined,
  now = new Date(),
): Promise<string | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null

  const [userId, expiresAt, nonce, signature] = parts as [string, string, string, string]
  if (userId === '') return null

  const expected = await sign(secret, `${userId}.${expiresAt}.${nonce}`)
  if (!constantTimeEqual(expected, signature)) return null

  const expiry = Number(expiresAt)
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return null
  return userId
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compares in time proportional to length, not to how much matches. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('')
}
