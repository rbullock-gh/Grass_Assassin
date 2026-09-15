import { readFileSync } from 'node:fs'
import { SignJWT } from 'jose'

/**
 * Mints a genuine access token, without going through the login endpoint.
 *
 * Sign-in is rate limited to ten attempts per five minutes per address, which is
 * correct and which every one of these scripts trips: they all run from one
 * machine, and a suite that signs in twenty times looks exactly like an attack.
 * Logging in is also not what any of them are measuring.
 *
 * The token is signed with the API's own secret and carries the issuer and
 * audience verifyAccessToken requires, so it is an ordinary valid token — not a
 * test bypass. Leaving the issuer out once produced a run where every request
 * came back 401 and the report read as though the marketplace were broken.
 */

export function accessSecret() {
  if (process.env.JWT_ACCESS_SECRET) return process.env.JWT_ACCESS_SECRET
  const env = readFileSync(new URL('../../apps/api/.env', import.meta.url), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith('JWT_ACCESS_SECRET='))
  if (!line) throw new Error('No JWT_ACCESS_SECRET — set it, or put it in apps/api/.env')
  return line.slice('JWT_ACCESS_SECRET='.length).trim()
}

export async function mintAccessToken(userId, roles, secret = accessSecret()) {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer('grassassassin')
    .setAudience('grassassassin-app')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

/** The token plus the /me payload the app keeps beside it. */
export async function sessionFor(api, userId, roles) {
  const accessToken = await mintAccessToken(userId, roles)
  const response = await fetch(`${api.replace(/\/$/, '')}/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Minted token was refused by /me (${response.status}) — secret mismatch?`)
  }
  return { accessToken, user: await response.json() }
}
