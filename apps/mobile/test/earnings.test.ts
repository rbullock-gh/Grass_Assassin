import { describe, expect, it } from 'vitest'
import { RANKS } from '@grassassassin/shared'
import { payoutStatusLabel, progressToNextRank } from '@/lib/earnings'
import { layoutFor } from '@/lib/responsive'

describe('payout status wording', () => {
  it('names the arrival date when the bank gave us one', () => {
    expect(payoutStatusLabel('IN_TRANSIT', '2026-09-18T00:00:00Z')).toContain('Sep 1')
  })

  it('still says something useful with no arrival date', () => {
    expect(payoutStatusLabel('PENDING', null)).toBe('On its way to your bank')
  })

  it('never says a payout failed without saying where the money went', () => {
    // "Failed" alone reads as "your money is gone", which is both false and the
    // fastest way to lose a worker.
    const failed = payoutStatusLabel('FAILED', null)
    expect(failed).toContain('still yours')

    const cancelled = payoutStatusLabel('CANCELED', null)
    expect(cancelled).toContain('available balance')
  })

  it('handles an unrecognised status without showing a raw enum', () => {
    expect(payoutStatusLabel('SOME_NEW_STATE', null)).toBe('some new state')
  })

  it('ignores an unparseable arrival date instead of rendering NaN', () => {
    expect(payoutStatusLabel('PAID', 'tomorrow-ish')).toBe('Paid')
  })
})

describe('rank progress', () => {
  it('starts a brand new worker at Rookie', () => {
    const progress = progressToNextRank(0, null)!
    expect(progress.currentName).toBe('Rookie')
    expect(progress.nextName).toBe('Trimmer')
    expect(progress.pointsRemaining).toBe(500)
    expect(progress.fraction).toBe(0)
  })

  it('fills the bar proportionally between ranks', () => {
    const progress = progressToNextRank(250, 'ROOKIE')!
    expect(progress.fraction).toBeCloseTo(0.5, 5)
    expect(progress.pointsRemaining).toBe(250)
  })

  it('never reports a negative remaining or a fraction outside 0..1', () => {
    for (const points of [0, 1, 499, 500, 9_999, 60_000, 250_000]) {
      for (const rank of RANKS) {
        const progress = progressToNextRank(points, rank.key)!
        expect(progress.pointsRemaining, `${rank.key}@${points}`).toBeGreaterThanOrEqual(0)
        expect(progress.fraction).toBeGreaterThanOrEqual(0)
        expect(progress.fraction).toBeLessThanOrEqual(1)
      }
    }
  })

  it('says there is nothing above the top rank rather than inventing one', () => {
    const progress = progressToNextRank(100_000, 'LEGEND')!
    expect(progress.nextName).toBeNull()
    expect(progress.gated).toBe(false)
  })

  it('states the quality gate the whole way up, not at the finish line', () => {
    // A worker can hit 1,500 points and still not be a Lawn Ranger, because the
    // rank also needs a 4.2 rating. Someone who learns that on arrival
    // concludes the ladder is rigged.
    const progress = progressToNextRank(600, 'TRIMMER')!
    expect(progress.nextName).toBe('Lawn Ranger')
    expect(progress.gated).toBe(true)
    expect(progress.gateHint).toContain('4.2★')
    expect(progress.gateHint).toContain('85% completion')
    expect(progress.gateHint).toContain('80% on time')
  })

  it('reads as a sentence with one gate and with several', () => {
    expect(progressToNextRank(0, 'ROOKIE')!.gateHint).toBe('keep 80% completion')
    expect(progressToNextRank(600, 'TRIMMER')!.gateHint)
      .toBe('keep a 4.2★ rating, 85% completion and 80% on time')
  })

  it('falls back to Rookie for a rank key this build does not know', () => {
    // An admin can add ranks. An app one version behind must not crash.
    const progress = progressToNextRank(100, 'SUPREME_OVERLORD')!
    expect(progress.currentName).toBe('Rookie')
  })
})

describe('content width', () => {
  it('never adds dead margins on the device the screen was designed for', () => {
    expect(layoutFor(390, 844).contentMaxWidth).toBe(390)
    expect(layoutFor(344, 882).contentMaxWidth).toBe(344)
  })

  it('caps a single-column reading surface on a large display', () => {
    // A 2000px-wide text input is the "stretched phone interface" failure in
    // reverse: technically responsive, unusable in practice.
    expect(layoutFor(1440, 900).contentMaxWidth).toBe(640)
    expect(layoutFor(2560, 1440).contentMaxWidth).toBe(640)
  })

  it('never returns a cap wider than the viewport', () => {
    for (const width of [320, 375, 390, 412, 600, 768, 834, 1024, 1280, 1920, 2560]) {
      expect(layoutFor(width, 900).contentMaxWidth, String(width)).toBeLessThanOrEqual(width)
    }
  })
})
