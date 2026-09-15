import 'server-only'
import { cookies } from 'next/headers'
import argon2 from 'argon2'
import { db } from './db'
import { adminSecret, readSession, sessionCookieName } from './session'

/**
 * Who is signed in, and are they still allowed to be.
 *
 * Node-side only. Kept apart from session.ts because argon2 is a native module
 * and Prisma is not edge-safe, while session.ts has to run in middleware.
 */

export interface AdminUser {
  id: string
  email: string
  firstName: string
  lastName: string | null
}

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

/**
 * A dummy hash, verified against when no matching account exists.
 *
 * Without it a sign-in attempt for an unknown email returns in about a
 * millisecond while a real account takes fifty, and that gap tells an attacker
 * which addresses are administrators. Both paths now cost the same.
 */
let dummyHash: string | null = null
async function equaliseTiming(): Promise<void> {
  dummyHash ??= await argon2.hash('timing-equalisation-placeholder', ARGON_OPTIONS)
  await argon2.verify(dummyHash, 'not-the-placeholder').catch(() => false)
}

/**
 * Checks an email and password against a real administrator account.
 *
 * Returns the user or null — never a reason. Distinguishing "no such account"
 * from "wrong password" from "not an administrator" hands over a list of who
 * has access here, and none of those distinctions help the person actually
 * signing in.
 */
export async function authenticateAdmin(
  email: string,
  password: string,
): Promise<AdminUser | null> {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      passwordHash: true, roles: true, status: true, deletedAt: true, suspendedUntil: true,
    },
  })

  if (!user) {
    await equaliseTiming()
    return null
  }

  const ok = await argon2.verify(user.passwordHash, password).catch(() => false)
  if (!ok || !isEligible(user)) return null

  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
}

/**
 * The administrator this request belongs to, re-read from the database.
 *
 * The cookie asserts an identity; this confirms the account behind it still
 * exists, is still active, and still holds the role. Without this re-read a
 * revoked administrator would keep full access until their cookie expired,
 * which on a surface that moves money is not an acceptable window.
 */
export async function currentAdmin(): Promise<AdminUser | null> {
  const secret = adminSecret()
  if (!secret) return null

  const store = await cookies()
  const userId = await readSession(secret, store.get(sessionCookieName())?.value)
  if (!userId) return null

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      roles: true, status: true, deletedAt: true, suspendedUntil: true,
    },
  })
  if (!user || !isEligible(user)) return null

  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
}

/**
 * The same check, for code paths that must not proceed without an actor.
 *
 * Every server action that changes money or state uses this rather than
 * currentAdmin, so "no administrator" is a thrown error instead of a null that
 * something downstream quietly treats as a missing optional field.
 */
export async function requireAdminUser(): Promise<AdminUser> {
  const admin = await currentAdmin()
  if (!admin) throw new Error('Not signed in as an administrator')
  return admin
}

interface Eligibility {
  roles: string[]
  status: string
  deletedAt: Date | null
  suspendedUntil: Date | null
}

/** Every reason an account must not hold an admin session, in one place. */
function isEligible(user: Eligibility): boolean {
  if (!user.roles.includes('ADMIN')) return false
  if (user.status !== 'ACTIVE') return false
  if (user.deletedAt !== null) return false
  if (user.suspendedUntil !== null && user.suspendedUntil > new Date()) return false
  return true
}
