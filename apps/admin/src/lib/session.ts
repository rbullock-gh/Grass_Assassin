/**
 * Admin authentication.
 *
 * This dashboard shipped with none, justified as "a staff tool on a trusted
 * network". That was defensible while every page was read-only. It stopped
 * being defensible the moment it could change the platform commission and
 * resolve disputes: anyone who can reach the port can now move money.
 *
 * So: a single shared password, held in an environment variable, exchanged for
 * a signed session cookie. Not an identity system — there is one operator role
 * and no per-person audit trail yet, which is a real limitation and is written
 * down rather than hidden. It is the difference between "staff only" and
 * "anyone who can reach the port", which is the gap that actually matters.
 *
 * Built on Web Crypto rather than node:crypto because the check runs in
 * middleware, which Next executes on the Edge runtime where node:crypto does
 * not exist. Everything here is therefore async, and works unchanged in both.
 */

const COOKIE = 'ga_admin'
const SESSION_HOURS = 12

export interface AdminEnv {
  password: string
  secret: string
}

/**
 * Reads the configuration, refusing to run half-secured.
 *
 * A missing password in production is a fatal misconfiguration, not a reason to
 * fall back to open access — "defaults to unlocked" is the failure mode that
 * puts an unauthenticated money surface on the internet.
 */
export function adminEnv(): AdminEnv | null {
  const password = process.env.ADMIN_PASSWORD
  const secret = process.env.ADMIN_SESSION_SECRET

  if (!password || !secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ADMIN_PASSWORD and ADMIN_SESSION_SECRET are required. The admin dashboard can change ' +
        'fees and resolve disputes; it must not run unauthenticated.',
      )
    }
    return null
  }
  if (secret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters')
  }
  return { password, secret }
}

export function sessionCookieName(): string {
  return COOKIE
}

/** Issues a session token: expiry and a nonce, plus an HMAC over both. */
export async function issueSession(secret: string, now = new Date()): Promise<string> {
  const expiresAt = now.getTime() + SESSION_HOURS * 3_600_000
  const nonce = randomHex(8)
  const payload = `${expiresAt}.${nonce}`
  return `${payload}.${await sign(secret, payload)}`
}

export async function verifySession(
  secret: string,
  token: string | undefined,
  now = new Date(),
): Promise<boolean> {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false

  const [expiresAt, nonce, signature] = parts as [string, string, string]
  const expected = await sign(secret, `${expiresAt}.${nonce}`)
  if (!constantTimeEqual(expected, signature)) return false

  const expiry = Number(expiresAt)
  return Number.isFinite(expiry) && expiry > now.getTime()
}

/**
 * Compares the submitted password without leaking its length or prefix.
 *
 * Hashed first so the comparison is always over two equal-length strings; a
 * direct comparison returns early on the first wrong byte, and that is
 * measurable.
 */
export async function passwordMatches(expected: string, submitted: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    sign('password-compare', expected),
    sign('password-compare', submitted),
  ])
  return constantTimeEqual(a, b)
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
