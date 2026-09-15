/**
 * The creative. Copy lives here, separately from the renderer, because this is
 * the file a human edits and the one apps/web/test/marketing-copy.test.ts scans
 * for numbers the product does not actually charge.
 *
 * Three rules govern every line of this, and all three come from the repo:
 *
 * 1. **docs/00-strategy.md R2 — worker misclassification.** Nothing may frame
 *    this as employment. No "join our team", no "we're hiring", no "apply", no
 *    assigned work, and ranks are an earned rate reduction, never performance
 *    management. This is an existential legal risk, and it happens to produce
 *    the strongest copy available: self-determination is the real difference
 *    between this and the gig apps people already resent.
 * 2. **docs/00-strategy.md Q3 — premium, competitive, humour only in
 *    micro-copy.** The name is already funny; the creative must not be.
 * 3. **Nothing is claimed that has not launched.** There is no app to download,
 *    no market open, and no users to count. Every post points at a waitlist.
 *
 * Worker-first ordering is deliberate: Q4 says the launch market is decided by
 * where the first 30 workers can be recruited, so supply is the ad spend's job.
 */

/** @typedef {'worker' | 'homeowner' | 'both'} Audience */

export const posts = [
  {
    slug: '01-keep-88',
    audience: 'worker',
    layout: 'numeral',
    size: 'feed',
    eyebrow: 'Independent lawn pros',
    numeral: '88%',
    headline: 'of the job price is yours.',
    support: 'Commission is 12%, and it falls to 8% as you rank up. Tips are never touched.',
  },
  {
    slug: '02-decline-free',
    audience: 'worker',
    layout: 'statement',
    size: 'feed',
    eyebrow: 'No penalty. Not ever.',
    headline: 'Turning down a job costs you nothing.',
    support: 'No score to protect. No rank to lose. You set the radius and the schedule — '
      + 'work outside them never reaches you.',
  },
  {
    slug: '03-priced-before',
    audience: 'worker',
    layout: 'statement',
    size: 'feed',
    eyebrow: 'Stop quoting for free',
    headline: 'The price is set before you ever see the job.',
    support: 'No bidding. No driving across town to hand someone a number. '
      + 'It is on the map, priced and scoped — claim it or skip it.',
  },
  {
    slug: '04-rank-ladder',
    audience: 'worker',
    layout: 'ladder',
    size: 'feed',
    eyebrow: 'Earned, never bought',
    headline: 'Your commission goes down as you go up.',
    support: 'Rank comes from rating, completion and on-time work over a rolling window.',
    // Literal rather than imported because this file is plain JS and the domain
    // package is TypeScript. apps/web/test/marketing-copy.test.ts asserts these
    // rows match RANKS exactly, so the poster cannot outlive the ladder.
    ladderRows: [
      ['Rookie', '0', '12%'],
      ['Trimmer', '500', '12%'],
      ['Lawn Ranger', '1,500', '12%'],
      ['Yard Hunter', '4,000', '11%'],
      ['Grass Assassin', '10,000', '10%'],
      ['Elite Assassin', '25,000', '9%'],
      ['Legend', '60,000', '8%'],
    ],
  },
  {
    slug: '05-you-set-the-price',
    audience: 'homeowner',
    layout: 'statement',
    size: 'feed',
    eyebrow: 'For people with a lawn',
    headline: 'You set the price. Someone nearby claims it.',
    support: 'Post what the job is worth to you, from $25. No waiting a week for a quote, '
      + 'and nobody turning up just to give you a number.',
  },
  {
    slug: '06-approve-then-pay',
    audience: 'homeowner',
    layout: 'statement',
    size: 'feed',
    eyebrow: 'For people with a lawn',
    headline: 'Nothing leaves your account until you have seen the work.',
    support: 'Before-and-after photos land in the app. You approve. Then they get paid. '
      + 'Cancelling before anyone claims it costs nothing.',
  },
  {
    slug: '07-pick-a-city',
    audience: 'both',
    layout: 'statement',
    size: 'story',
    eyebrow: 'Waitlist open',
    headline: 'We have not picked a first city yet.',
    support: 'Yours could be it. Drop your ZIP and we will go where the most people asked.',
    cta: 'Link in bio',
  },
]
