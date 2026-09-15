/**
 * Every number the marketing copy states must be one the product actually charges.
 *
 * The failure this prevents is mundane and expensive: someone edits a sentence,
 * types "15%" because it reads better, and the page now advertises a rate the
 * API does not charge. Deriving the numbers in content.ts stops that for the
 * derived strings; this scans the finished prose and catches a literal typed
 * into the middle of a sentence, which derivation cannot.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FEE_CONFIG, RANKS } from '@grassassassin/shared'
import { AUDIENCES, FAQ, fees, ranks } from '@/content'

const pct = (bps: number) => `${bps / 100}%`

/** Every percentage the product can legitimately quote. */
const allowedPercents = new Set<string>([
  ...RANKS.map((r) => pct(DEFAULT_FEE_CONFIG.workerCommissionBps - r.commissionDiscountBps)),
  ...RANKS.map((r) => pct(10_000 - DEFAULT_FEE_CONFIG.workerCommissionBps + r.commissionDiscountBps)),
  pct(DEFAULT_FEE_CONFIG.customerServiceFeeBps),
  '100%', // tips, of which the platform takes nothing
])

const money = (cents: number) => {
  const d = cents / 100
  return `$${Number.isInteger(d) ? d : d.toFixed(2)}`
}

const allowedMoney = new Set<string>([
  money(DEFAULT_FEE_CONFIG.minJobPriceCents),
  money(DEFAULT_FEE_CONFIG.customerServiceFeeMinCents),
  '$0',
])

/** Every sentence the page shows, with a label for the failure message. */
const prose: ReadonlyArray<readonly [string, string]> = [
  ...FAQ.flatMap((e) => [
    [`FAQ question "${e.q}"`, e.q] as const,
    [`FAQ answer to "${e.q}"`, e.a] as const,
  ]),
  ...(['home', 'pro'] as const).flatMap((k) => [
    [`${k} pitch`, AUDIENCES[k].pitch] as const,
    [`${k} form intro`, AUDIENCES[k].formIntro] as const,
    [`${k} small print`, AUDIENCES[k].fine] as const,
    ...AUDIENCES[k].ticks.map((t, i) => [`${k} tick ${i + 1}`, t] as const),
  ]),
]

describe('the copy only quotes numbers the product charges', () => {
  it.each(prose)('%s', (_label, text) => {
    for (const found of text.match(/\d+(?:\.\d+)?%/g) ?? []) {
      expect(allowedPercents, `"${found}" is not a rate this product charges`)
        .toContain(found)
    }
    for (const found of text.match(/\$\d+(?:\.\d{2})?/g) ?? []) {
      expect(allowedMoney, `"${found}" is not an amount from the fee config`)
        .toContain(found)
    }
  })
})

describe('derived fees', () => {
  it('states commission and take-home as complements', () => {
    expect(parseFloat(fees.workerCommission) + parseFloat(fees.workerKeeps)).toBe(100)
    expect(parseFloat(fees.workerBestCommission) + parseFloat(fees.workerBestKeeps)).toBe(100)
  })

  it('quotes the best rank as better than the standing rate', () => {
    expect(parseFloat(fees.workerBestCommission)).toBeLessThan(parseFloat(fees.workerCommission))
  })

  it('matches the API defaults exactly', () => {
    expect(fees.workerCommission).toBe(pct(DEFAULT_FEE_CONFIG.workerCommissionBps))
    expect(fees.serviceFee).toBe(pct(DEFAULT_FEE_CONFIG.customerServiceFeeBps))
    expect(fees.serviceFeeFloor).toBe(money(DEFAULT_FEE_CONFIG.customerServiceFeeMinCents))
    expect(fees.minJob).toBe(money(DEFAULT_FEE_CONFIG.minJobPriceCents))
  })
})

describe('the rank ladder', () => {
  it('shows every rank, not only the ones that cut commission', () => {
    expect(ranks).toHaveLength(RANKS.length)
    expect(ranks.map((r) => r.name)).toEqual(RANKS.map((r) => r.name))
  })

  it('marks exactly the ranks that earn a reduction', () => {
    expect(ranks.filter((r) => r.discounted).map((r) => r.name))
      .toEqual(RANKS.filter((r) => r.commissionDiscountBps > 0).map((r) => r.name))
  })
})

describe('the FAQ', () => {
  it('asks each question once', () => {
    expect(new Set(FAQ.map((e) => e.q)).size).toBe(FAQ.length)
  })

  it('answers every question with something substantive', () => {
    for (const entry of FAQ) expect(entry.a.length).toBeGreaterThan(40)
  })
})
