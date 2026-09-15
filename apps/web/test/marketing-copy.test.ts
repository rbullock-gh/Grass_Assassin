/**
 * The Instagram creative is held to the same two rules as the landing page,
 * plus one it needs on its own.
 *
 * 1. Numbers must be ones the product charges. Ad copy is edited far more
 *    casually than code, usually in a hurry, often by someone who is not
 *    looking at pricing.ts.
 * 2. The rank ladder on the poster must match RANKS. A poster outlives the
 *    config that produced it.
 * 3. **No employment framing.** docs/00-strategy.md R2 calls worker
 *    misclassification an existential legal risk and says the product must
 *    never exert employment-style control. Advertising is where that slips
 *    first, because "join our team" is the most natural phrase in recruitment
 *    copy and it is exactly the phrase a plaintiff's lawyer would enjoy. This
 *    is a legal constraint expressed as a test.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FEE_CONFIG, RANKS } from '@grassassassin/shared'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const POSTS_SRC = read('../marketing/instagram/posts.mjs')
const CAPTIONS_SRC = read('../marketing/instagram/captions.md')

/** Comments explain the rules; they are not copy that ships. */
const stripComments = (js: string) =>
  js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * Only blockquoted lines in captions.md are copy that gets posted. The rest of
 * the file is guidance about the copy — including the section that quotes
 * forbidden phrasing in order to forbid it, which must not be scanned as if it
 * were a caption.
 */
const captionText = CAPTIONS_SRC.split('\n')
  .filter((line) => line.startsWith('> '))
  .join('\n')

const surfaces: ReadonlyArray<readonly [string, string]> = [
  ['posts.mjs', stripComments(POSTS_SRC)],
  ['captions.md blockquotes', captionText],
]

const pct = (bps: number) => `${bps / 100}%`
const money = (cents: number) => {
  const d = cents / 100
  return `$${Number.isInteger(d) ? d : d.toFixed(2)}`
}

const allowedPercents = new Set<string>([
  ...RANKS.map((r) => pct(DEFAULT_FEE_CONFIG.workerCommissionBps - r.commissionDiscountBps)),
  ...RANKS.map((r) => pct(10_000 - DEFAULT_FEE_CONFIG.workerCommissionBps + r.commissionDiscountBps)),
  pct(DEFAULT_FEE_CONFIG.customerServiceFeeBps),
  '100%',
])

const allowedMoney = new Set<string>([
  money(DEFAULT_FEE_CONFIG.minJobPriceCents),
  money(DEFAULT_FEE_CONFIG.customerServiceFeeMinCents),
  '$0',
])

describe('the ad creative only quotes numbers the product charges', () => {
  it.each(surfaces)('%s', (_name, text) => {
    for (const found of text.match(/\d+(?:\.\d+)?%/g) ?? []) {
      expect(allowedPercents, `"${found}" is not a rate this product charges`).toContain(found)
    }
    for (const found of text.match(/\$\d[\d,]*(?:\.\d{2})?/g) ?? []) {
      expect(allowedMoney, `"${found}" is not an amount from the fee config`).toContain(found)
    }
  })
})

describe('the rank ladder poster', () => {
  /** Pulled back out of the creative so it is checked as data, not as prose. */
  const rows = [...POSTS_SRC.matchAll(/\['([^']+)', '([\d,]+)', '(\d+%)'\]/g)]
    .map((m) => ({ name: m[1], points: m[2], rate: m[3] }))

  it('lists every rank', () => {
    expect(rows.map((r) => r.name)).toEqual(RANKS.map((r) => r.name))
  })

  it('states each threshold as RANKS defines it', () => {
    expect(rows.map((r) => r.points))
      .toEqual(RANKS.map((r) => r.minPoints.toLocaleString('en-US')))
  })

  it('states each commission as the fee config computes it', () => {
    expect(rows.map((r) => r.rate)).toEqual(
      RANKS.map((r) => pct(DEFAULT_FEE_CONFIG.workerCommissionBps - r.commissionDiscountBps)),
    )
  })
})

describe('docs/00-strategy.md R2 — no employment framing', () => {
  // Each of these would be read as evidence of an employment relationship
  // rather than an independent one. The list is deliberately phrase-level:
  // "apply" alone appears innocently, "apply now" does not.
  const forbidden = [
    'join our team', 'join the team', "we're hiring", 'we are hiring',
    'now hiring', 'apply now', 'apply today', 'job application',
    'employee', 'employment', 'your boss', 'our workers', 'our employees',
    'shift', 'clock in', 'assigned to you', 'we assign',
  ]

  it.each(surfaces)('%s uses none of the banned phrasing', (_name, text) => {
    const lower = text.toLowerCase()
    const hits = forbidden.filter((phrase) => lower.includes(phrase))
    expect(hits, `employment framing found: ${hits.join(', ')}`).toEqual([])
  })

  it.each(surfaces)('%s does not imply the app can be downloaded', (_name, text) => {
    const lower = text.toLowerCase()
    const hits = ['download now', 'get the app', 'available now', 'download the app']
      .filter((phrase) => lower.includes(phrase))
    expect(hits, `implies availability that does not exist: ${hits.join(', ')}`).toEqual([])
  })
})
