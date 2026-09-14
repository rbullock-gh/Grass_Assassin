import argon2 from 'argon2'
import { createHash } from 'node:crypto'

/**
 * Password hashing.
 *
 * argon2id, not bcrypt: it is the current password-hashing competition winner
 * and the only widely available algorithm with meaningful GPU and side-channel
 * resistance. The parameters below follow OWASP's 2024 guidance — 19 MiB of
 * memory and 2 iterations — which costs roughly 50ms per hash on server
 * hardware. That is deliberately slow; it is what makes an offline attack on a
 * leaked table expensive.
 */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that distinguishes this account from any other.
    return false
  }
}

/**
 * A dummy hash of a fixed string, used to equalise login timing.
 *
 * Without this, a login against a nonexistent email returns in ~1ms while a real
 * account takes ~50ms, and that difference lets anyone enumerate which email
 * addresses have accounts. We verify against this constant when the user is not
 * found so both paths cost the same.
 */
let dummyHashCache: string | null = null

export async function getDummyHash(): Promise<string> {
  dummyHashCache ??= await hashPassword('timing-equalisation-placeholder')
  return dummyHashCache
}

/** IPs are hashed before storage — we need to correlate sessions, not identify people. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32)
}
