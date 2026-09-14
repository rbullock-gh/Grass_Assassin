import { describe, it, expect } from 'vitest'
import {
  RANKS, resolveRank, nextRank, progressToNextRank, difficultyBonus,
  canSeeDuringEarlyAccess, DEFAULT_POINT_VALUES, POINT_EVENTS,
  NEW_WORKER_EARLY_ACCESS_EXEMPT_JOBS, type WorkerQualityStats,
} from '../src/domain/points.js'

const perfect = (points: number): WorkerQualityStats => ({
  points, averageRating: 5, completionRate: 1, onTimeRate: 1, completedJobs: 200,
})

describe('point values', () => {
  it('has a value defined for every event', () => {
    for (const e of POINT_EVENTS) expect(DEFAULT_POINT_VALUES[e]).toBeTypeOf('number')
  })

  it('never penalises declining a job', () => {
    // Strategy R2: penalising declines is evidence of employment-style control.
    const eventNames = POINT_EVENTS.join(',')
    expect(eventNames).not.toMatch(/DECLIN/i)
    expect(eventNames).not.toMatch(/IGNORED/i)
  })

  it('weights quality above beating the deadline, so speed is never the play', () => {
    expect(DEFAULT_POINT_VALUES.JOB_COMPLETED).toBeGreaterThan(DEFAULT_POINT_VALUES.COMPLETED_BEFORE_DEADLINE * 3)
    expect(DEFAULT_POINT_VALUES.COMPLETED_BEFORE_DEADLINE).toBeLessThanOrEqual(DEFAULT_POINT_VALUES.FIVE_STAR_REVIEW * 1.5)
  })

  it('makes a no-show cost far more than any single job earns', () => {
    expect(Math.abs(DEFAULT_POINT_VALUES.NO_SHOW)).toBeGreaterThan(DEFAULT_POINT_VALUES.JOB_COMPLETED * 2)
  })

  it('rewards keeping repeat customers on platform', () => {
    expect(DEFAULT_POINT_VALUES.REPEAT_CUSTOMER).toBeGreaterThan(0)
  })
})

describe('difficultyBonus', () => {
  it('scales with time and category difficulty', () => {
    const small = difficultyBonus({ estimatedMinutes: 30, categoryDifficulty: 1 })
    const large = difficultyBonus({ estimatedMinutes: 180, categoryDifficulty: 4 })
    expect(large).toBeGreaterThan(small)
  })
  it('is capped so it cannot swamp quality signals', () => {
    expect(difficultyBonus({ estimatedMinutes: 10_000, categoryDifficulty: 5 })).toBeLessThanOrEqual(75)
  })
  it('is never negative', () => {
    expect(difficultyBonus({ estimatedMinutes: 0, categoryDifficulty: 1 })).toBeGreaterThanOrEqual(0)
  })
})

describe('rank tables', () => {
  it('is strictly ordered by points', () => {
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i]!.minPoints).toBeGreaterThan(RANKS[i - 1]!.minPoints)
    }
  })
  it('never reduces a benefit as rank increases', () => {
    for (let i = 1; i < RANKS.length; i++) {
      expect(RANKS[i]!.commissionDiscountBps).toBeGreaterThanOrEqual(RANKS[i - 1]!.commissionDiscountBps)
      expect(RANKS[i]!.radiusBonusMiles).toBeGreaterThanOrEqual(RANKS[i - 1]!.radiusBonusMiles)
    }
  })
  it('keeps commission discounts from ever exceeding the base rate', () => {
    for (const r of RANKS) expect(r.commissionDiscountBps).toBeLessThan(1200)
  })
  it('grants early access to at most the top two ranks', () => {
    expect(RANKS.filter((r) => r.earlyAccessMinutes > 0).length).toBeLessThanOrEqual(2)
  })
})

describe('resolveRank', () => {
  it('returns Rookie at zero points', () => {
    expect(resolveRank(perfect(0)).key).toBe('ROOKIE')
  })

  it('promotes a high-quality worker to the rank their points allow', () => {
    expect(resolveRank(perfect(10_000)).key).toBe('GRASS_ASSASSIN')
    expect(resolveRank(perfect(60_000)).key).toBe('LEGEND')
  })

  it('holds back a high-volume, low-quality worker at the quality gate', () => {
    // 30k points would be Elite Assassin on points alone, but a 3.9 rating
    // fails every gate from Lawn Ranger up.
    const grinder: WorkerQualityStats = {
      points: 30_000, averageRating: 3.9, completionRate: 0.99, onTimeRate: 0.99, completedJobs: 400,
    }
    const rank = resolveRank(grinder)
    expect(rank.key).toBe('TRIMMER')
    expect(rank.minPoints).toBeLessThan(30_000)
  })

  it('holds back a worker who cancels constantly', () => {
    const flaky: WorkerQualityStats = {
      points: 30_000, averageRating: 4.9, completionRate: 0.6, onTimeRate: 0.99, completedJobs: 400,
    }
    expect(resolveRank(flaky).key).toBe('ROOKIE')
  })

  it('holds back a chronically late worker', () => {
    const late: WorkerQualityStats = {
      points: 12_000, averageRating: 4.9, completionRate: 0.99, onTimeRate: 0.5, completedJobs: 200,
    }
    expect(resolveRank(late).key).toBe('TRIMMER')
  })

  it('treats an unrated worker as failing rating gates rather than passing them', () => {
    const unrated: WorkerQualityStats = {
      points: 20_000, averageRating: null, completionRate: 1, onTimeRate: 1, completedJobs: 1,
    }
    expect(resolveRank(unrated).key).toBe('TRIMMER')
  })

  it('never returns a rank above what points allow', () => {
    for (let p = 0; p <= 70_000; p += 137) {
      const r = resolveRank(perfect(p))
      expect(r.minPoints).toBeLessThanOrEqual(p)
    }
  })
})

describe('progressToNextRank', () => {
  it('reports remaining points and a 0..1 fraction', () => {
    const rookie = RANKS[0]!
    const p = progressToNextRank(250, rookie)
    expect(p).not.toBeNull()
    expect(p!.pointsNeeded).toBe(250)
    expect(p!.fraction).toBeCloseTo(0.5, 5)
  })
  it('returns null at the top rank', () => {
    expect(progressToNextRank(99_999, RANKS[RANKS.length - 1]!)).toBeNull()
  })
  it('clamps the fraction into range', () => {
    const p = progressToNextRank(499, RANKS[0]!)
    expect(p!.fraction).toBeGreaterThanOrEqual(0)
    expect(p!.fraction).toBeLessThanOrEqual(1)
  })
  it('finds the next rank above the current one', () => {
    expect(nextRank(RANKS[0]!)!.key).toBe('TRIMMER')
  })
})

describe('early access fairness safeguards', () => {
  const rookie = RANKS.find((r) => r.key === 'ROOKIE')!
  const legend = RANKS.find((r) => r.key === 'LEGEND')!

  it('never gates an ordinary job for anyone', () => {
    expect(canSeeDuringEarlyAccess({
      isPremiumJob: false, secondsSincePosted: 0, rank: rookie, completedJobs: 500,
    })).toBe(true)
  })

  it('exempts brand-new workers from every early-access delay', () => {
    expect(canSeeDuringEarlyAccess({
      isPremiumJob: true, secondsSincePosted: 0, rank: rookie,
      completedJobs: NEW_WORKER_EARLY_ACCESS_EXEMPT_JOBS - 1,
    })).toBe(true)
  })

  it('does briefly favour top ranks on premium jobs', () => {
    expect(canSeeDuringEarlyAccess({ isPremiumJob: true, secondsSincePosted: 0, rank: legend, completedJobs: 500 })).toBe(true)
    expect(canSeeDuringEarlyAccess({ isPremiumJob: true, secondsSincePosted: 0, rank: rookie, completedJobs: 500 })).toBe(false)
  })

  it('opens premium jobs to everyone once the window closes', () => {
    // Window is 10 minutes; nobody is excluded at 601 seconds.
    expect(canSeeDuringEarlyAccess({
      isPremiumJob: true, secondsSincePosted: 601, rank: rookie, completedJobs: 500,
    })).toBe(true)
  })

  it('keeps the exclusion window bounded to 10 minutes', () => {
    const maxWindow = Math.max(...RANKS.map((r) => r.earlyAccessMinutes)) * 60
    expect(maxWindow).toBeLessThanOrEqual(600)
  })
})
