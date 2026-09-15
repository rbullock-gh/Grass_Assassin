/**
 * Brute-force protection for admin sign-in.
 *
 * argon2 already makes each guess cost about 50ms, which is a floor but not a
 * limit — left alone, a patient attacker still gets millions of attempts a day
 * against a surface that can change platform fees and issue refunds.
 *
 * Two deliberate decisions about how NOT to do this:
 *
 * It does not lock accounts by email. An email-keyed lockout hands anyone who
 * knows an administrator's address the ability to lock them out on demand, and
 * the moment that matters — a dispute queue backing up, a fee set wrong — is
 * exactly when losing access is most expensive. So the per-address counter here
 * does not exist.
 *
 * It does not hard-block globally. A global ceiling would let one attacker
 * deny sign-in to every administrator by tripping it. Above the global
 * threshold every attempt is DELAYED instead, which destroys throughput for a
 * brute-force loop while leaving a real person a slow but working door.
 *
 * In-memory, so a second instance means a second allowance. That is a real
 * limitation and is written down rather than hidden; it is still the difference
 * between ten guesses per address per quarter hour and unlimited.
 */

export interface ThrottleDecision {
  /** Refuse outright. */
  blocked: boolean
  /** Sleep this long before answering, to slow a distributed attempt. */
  delayMs: number
  /** Seconds until the block lifts, for the message shown. */
  retryAfterSeconds: number
}

const WINDOW_MS = 15 * 60_000
const PER_IP_LIMIT = 10
const GLOBAL_TARPIT_AFTER = 100
const TARPIT_MS = 2_000

/** Bounds memory: an attacker rotating source addresses cannot grow this. */
const MAX_TRACKED_SOURCES = 10_000
/**
 * How far to prune below the cap.
 *
 * Trimming back to exactly the cap means the next insert is over it again, so
 * every subsequent failure pays for a full scan and sort — which under the
 * IP-rotating attack this exists to survive makes the defence the bottleneck.
 * Clearing headroom makes the cost amortised instead of per-attempt.
 */
const PRUNE_TARGET = Math.floor(MAX_TRACKED_SOURCES * 0.8)

const failures = new Map<string, number[]>()
let globalFailures: number[] = []
/** How many full sweeps have run. Exposed so a test can assert the sweep is
 *  amortised rather than per-attempt, without timing a wall clock. */
let sweeps = 0

function recent(times: number[], now: number): number[] {
  return times.filter((t) => now - t < WINDOW_MS)
}

/**
 * What to do with an attempt from this source, before checking the password.
 */
export function checkThrottle(source: string, now = Date.now()): ThrottleDecision {
  const mine = recent(failures.get(source) ?? [], now)
  globalFailures = recent(globalFailures, now)

  if (mine.length >= PER_IP_LIMIT) {
    const oldest = mine[0] as number
    return {
      blocked: true,
      delayMs: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
    }
  }

  return {
    blocked: false,
    delayMs: globalFailures.length >= GLOBAL_TARPIT_AFTER ? TARPIT_MS : 0,
    retryAfterSeconds: 0,
  }
}

export function recordFailure(source: string, now = Date.now()): void {
  const mine = recent(failures.get(source) ?? [], now)
  mine.push(now)
  failures.set(source, mine)

  globalFailures = recent(globalFailures, now)
  globalFailures.push(now)

  pruneIfCrowded(now)
}

/** A correct password clears the source's record; it was not an attack. */
export function recordSuccess(source: string): void {
  failures.delete(source)
}

function pruneIfCrowded(now: number): void {
  if (failures.size <= MAX_TRACKED_SOURCES) return
  sweeps += 1
  for (const [key, times] of failures) {
    if (recent(times, now).length === 0) failures.delete(key)
  }
  // Still full of live entries: drop the least recently active, because
  // refusing to track anything new would be the more useful failure for an
  // attacker than forgetting the oldest.
  if (failures.size > PRUNE_TARGET) {
    const byAge = [...failures.entries()]
      .sort((a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0))
    for (const [key] of byAge.slice(0, failures.size - PRUNE_TARGET)) {
      failures.delete(key)
    }
  }
}

/** Test seam. */
export function resetThrottle(): void {
  failures.clear()
  globalFailures = []
  sweeps = 0
}

/** Test seam: what the limiter is holding and how often it has swept. */
export function throttleStats(): { tracked: number; sweeps: number } {
  return { tracked: failures.size, sweeps }
}
