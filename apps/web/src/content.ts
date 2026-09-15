/**
 * Everything the marketing page claims, in one place.
 *
 * Two rules hold here:
 *
 * 1. **Numbers are derived, never typed.** Fees and ranks come from
 *    @grassassassin/shared, which is what the API actually charges. A marketing
 *    page that quotes 12% while the product charges 14% is worse than one that
 *    quotes nothing, and hand-copied numbers drift the first time a default
 *    moves.
 * 2. **The FAQ is declared once.** The rendered <details> and the FAQPage
 *    structured data are both generated from FAQ below. Google requires every
 *    answer in the markup to be visible on the page; generating both from one
 *    array makes that true by construction rather than by review.
 */
import { DEFAULT_FEE_CONFIG, RANKS } from '@grassassassin/shared'

const pct = (bps: number): string => `${bps / 100}%`

/** "$25" rather than "$25.00" — whole dollars read better in prose. */
const money = (cents: number): string => {
  const dollars = cents / 100
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`
}

/** The deepest commission discount any rank earns. */
const bestDiscountBps = Math.max(...RANKS.map((r) => r.commissionDiscountBps))

export const fees = {
  /** What the platform takes from the worker's side. */
  workerCommission: pct(DEFAULT_FEE_CONFIG.workerCommissionBps),
  /** The same number stated the way a worker thinks about it. */
  workerKeeps: pct(10_000 - DEFAULT_FEE_CONFIG.workerCommissionBps),
  /** Commission at the top rank, and what the worker keeps there. */
  workerBestCommission: pct(DEFAULT_FEE_CONFIG.workerCommissionBps - bestDiscountBps),
  workerBestKeeps: pct(10_000 - DEFAULT_FEE_CONFIG.workerCommissionBps + bestDiscountBps),
  /** What the customer pays on top of the job price. */
  serviceFee: pct(DEFAULT_FEE_CONFIG.customerServiceFeeBps),
  serviceFeeFloor: money(DEFAULT_FEE_CONFIG.customerServiceFeeMinCents),
  minJob: money(DEFAULT_FEE_CONFIG.minJobPriceCents),
} as const

/**
 * The full rank ladder.
 *
 * Every rank, not only the ones that move commission. Showing just those jumps
 * the table from 0 points straight to 4,000 and implies there is nothing in
 * between — a worker who later meets Trimmer and Lawn Ranger in the app would
 * have been told something untrue by omission.
 */
export const ranks = RANKS.map((r) => ({
  name: r.name,
  points: r.minPoints.toLocaleString('en-US'),
  commission: pct(DEFAULT_FEE_CONFIG.workerCommissionBps - r.commissionDiscountBps),
  /** Distinguishes an earned reduction from the standing rate. */
  discounted: r.commissionDiscountBps > 0,
}))

export interface FaqEntry {
  q: string
  a: string
}

export const FAQ: readonly FaqEntry[] = [
  {
    q: 'When does GrassAssassin launch?',
    a: 'There is no date yet, and we would rather say that than invent one. The app is built; '
      + 'what is not settled is which market opens first. Everyone on the waitlist hears before '
      + 'anyone else does.',
  },
  {
    q: 'Where will it work first?',
    a: 'That is what the ZIP code on the form is for. The first market is the one where enough '
      + 'homeowners and enough workers sign up in the same place — a marketplace with customers '
      + 'and no workers is useless to everybody, and the reverse is worse.',
  },
  {
    q: 'What does it cost a homeowner?',
    a: `You set the price for the job itself, from ${fees.minJob} up. On top of that there is a `
      + `${fees.serviceFee} service fee, with a ${fees.serviceFeeFloor} minimum. Nothing is `
      + 'charged until you approve the finished work.',
  },
  {
    q: 'What does it cost a worker?',
    a: `Commission is ${fees.workerCommission}, so you keep ${fees.workerKeeps} of the job price. `
      + `That falls to ${fees.workerBestCommission} as you rank up. Tips are yours in full — the `
      + 'platform takes nothing from them.',
  },
  {
    q: 'Who decides what a job pays?',
    a: 'The homeowner sets the price when they post, with guidance from us. Workers see that '
      + 'price before deciding whether to claim, so there is no bidding, no quoting, and no '
      + 'visit just to give a number.',
  },
  {
    q: 'Can I download it from the App Store today?',
    a: 'No. The app is built and tested, but it has not been through app store review and has '
      + 'not opened in any market. The waitlist is how we decide where to go first and who gets '
      + 'in at the start.',
  },
  {
    q: 'What happens to my email address?',
    a: 'We use it to tell you when GrassAssassin opens in your area, and for nothing else. It '
      + 'does not get sold or passed on, and every message has a one-click unsubscribe.',
  },
] as const

export const AUDIENCES = {
  home: {
    id: 'view-home',
    label: 'I have a lawn',
    pitch: 'Post the job. Someone nearby claims it.',
    ticks: [
      'You set the price — no waiting a week for a quote',
      'Before-and-after photos on every job',
      'You approve the work before anyone gets paid',
    ],
    formHeading: 'Get early access',
    formIntro: 'Two fields. The ZIP is the one that matters — it is how we decide where to open first.',
    fine: 'Free, and it commits you to nothing. One email when we open near you.',
  },
  pro: {
    id: 'view-pro',
    label: 'I cut grass',
    pitch: 'Jobs on a map. Claim the ones already on your route.',
    ticks: [
      `Keep ${fees.workerKeeps} of the job price, rising to ${fees.workerBestKeeps} as you rank up`,
      'The price is set before you see it — no bidding, no quoting',
      'Paid through the app when the customer approves',
    ],
    formHeading: 'Get on the worker list',
    formIntro: 'Workers get talked to first. We open a market by recruiting its workers, not its customers.',
    fine: 'Free. We will ask what you charge for and how far you drive — not today.',
  },
} as const
