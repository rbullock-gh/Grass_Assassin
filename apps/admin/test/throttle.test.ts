import { describe, expect, it, beforeEach } from 'vitest'
import {
  checkThrottle, recordFailure, recordSuccess, resetThrottle, throttleStats,
} from '../src/lib/throttle'

const WINDOW_MS = 15 * 60_000
const MAX_TRACKED = 10_000

beforeEach(() => resetThrottle())

describe('per-source blocking', () => {
  it('allows the first attempts and blocks after ten failures', () => {
    const now = Date.now()
    for (let i = 0; i < 9; i += 1) {
      expect(checkThrottle('1.2.3.4', now).blocked, `attempt ${i + 1}`).toBe(false)
      recordFailure('1.2.3.4', now)
    }
    expect(checkThrottle('1.2.3.4', now).blocked).toBe(false)
    recordFailure('1.2.3.4', now)
    expect(checkThrottle('1.2.3.4', now).blocked).toBe(true)
  })

  it('does not punish one source for the failures of another', () => {
    const now = Date.now()
    for (let i = 0; i < 20; i += 1) recordFailure('1.2.3.4', now)
    expect(checkThrottle('1.2.3.4', now).blocked).toBe(true)
    expect(checkThrottle('5.6.7.8', now).blocked).toBe(false)
  })

  it('forgets failures once the window has passed', () => {
    const now = Date.now()
    for (let i = 0; i < 10; i += 1) recordFailure('1.2.3.4', now)
    expect(checkThrottle('1.2.3.4', now).blocked).toBe(true)
    expect(checkThrottle('1.2.3.4', now + WINDOW_MS + 1000).blocked).toBe(false)
  })

  it('says how long the block lasts', () => {
    const now = Date.now()
    for (let i = 0; i < 10; i += 1) recordFailure('1.2.3.4', now)
    const seconds = checkThrottle('1.2.3.4', now + 60_000).retryAfterSeconds
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(WINDOW_MS / 1000)
  })

  it('clears the record when the password was right', () => {
    const now = Date.now()
    for (let i = 0; i < 9; i += 1) recordFailure('1.2.3.4', now)
    recordSuccess('1.2.3.4')
    for (let i = 0; i < 9; i += 1) {
      expect(checkThrottle('1.2.3.4', now).blocked).toBe(false)
      recordFailure('1.2.3.4', now)
    }
  })
})

describe('the global tarpit', () => {
  it('does not delay ordinary traffic', () => {
    expect(checkThrottle('1.2.3.4').delayMs).toBe(0)
  })

  it('delays everyone once failures are widespread, but blocks nobody', () => {
    // The point: a distributed attempt spread over many addresses never trips
    // the per-source limit, so something has to notice the aggregate.
    const now = Date.now()
    for (let i = 0; i < 100; i += 1) recordFailure(`10.0.${Math.floor(i / 255)}.${i % 255}`, now)

    const decision = checkThrottle('192.168.1.1', now)
    expect(decision.delayMs).toBeGreaterThan(0)
    // Crucially NOT blocked — otherwise one attacker locks out every
    // administrator by making a hundred bad guesses.
    expect(decision.blocked).toBe(false)
  })

  it('stops delaying once the wave has passed', () => {
    const now = Date.now()
    for (let i = 0; i < 100; i += 1) recordFailure(`10.0.${Math.floor(i / 255)}.${i % 255}`, now)
    expect(checkThrottle('192.168.1.1', now + WINDOW_MS + 1000).delayMs).toBe(0)
  })
})

describe('memory', () => {
  it('does not grow without bound when an attacker rotates addresses', () => {
    // Ten thousand tracked sources is the cap; a rotating attacker must not be
    // able to turn it into a million map entries.
    const now = Date.now()
    for (let i = 0; i < 15_000; i += 1) recordFailure(`src-${i}`, now)
    expect(throttleStats().tracked).toBeLessThanOrEqual(MAX_TRACKED)

    // And it is still enforcing for a source that is actively failing.
    for (let i = 0; i < 10; i += 1) recordFailure('persistent', now)
    expect(checkThrottle('persistent', now).blocked).toBe(true)
  })

  it('sweeps rarely rather than on every attempt', () => {
    // The first version trimmed back to exactly the cap, so the very next
    // insert was over it again and every subsequent attempt paid for a full
    // scan and sort. A rate limiter that gets slower the harder it is attacked
    // is a denial of service with extra steps.
    //
    // Asserted as a count rather than a duration on purpose: timing this under
    // a test runner measures the runner, not the algorithm — the first attempt
    // at this test read 0.43ms per attempt where the code itself takes 0.006ms.
    const now = Date.now()
    for (let i = 0; i < MAX_TRACKED; i += 1) recordFailure(`warm-${i}`, now)
    const before = throttleStats().sweeps

    const attempts = 5_000
    for (let i = 0; i < attempts; i += 1) recordFailure(`attack-${i}`, now)
    const sweeps = throttleStats().sweeps - before

    // Headroom is 20% of the cap, so 5000 inserts should cost about three
    // sweeps. Per-attempt sweeping would be 5000.
    expect(sweeps, `${sweeps} sweeps for ${attempts} attempts`).toBeLessThan(10)
  })
})
