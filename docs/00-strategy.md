# GrassAssassin — Strategy Brief
**Author:** JARVIS · **Status:** v1 for founder review · **Date:** 2026-09-14

---

## 1. What this business actually is

GrassAssassin is a **local labor marketplace with scheduled (not real-time) fulfillment**.

That distinction drives almost every architectural decision, so it is worth stating precisely.
People reach for the "DoorDash for lawns" analogy, but the mechanics differ in four ways that
matter:

| | DoorDash | GrassAssassin |
|---|---|---|
| Time from order to fulfillment | 10–40 min | 4 hours – 7 days |
| Worker is | dispatched by algorithm | self-selecting from a pool |
| Price is set by | platform | **customer** (this is unusual and risky) |
| Job verification | delivery photo | before/after photos + customer approval |

The closest real comparables are **Thumbtack, TaskRabbit, Lawn Love, and GreenPal**.
GreenPal in particular is the direct competitor — lawn-specific, bid-based, ~$60 average ticket.
Lawn Love is the well-funded one and it is a *routed* model, not a marketplace.

Our wedge versus all of them: **map-first instant claiming with no bidding round**.
GreenPal makes a homeowner wait for bids. Thumbtack makes them field five phone calls.
We make a job claimable in one tap, which compresses "I want my lawn mowed" to "someone is
coming Thursday" from ~2 days down to ~2 minutes. That is a real, defensible product difference,
and the whole MVP should be pointed at it.

---

## 2. Risk register

Ordered by expected damage, not by likelihood. The mitigations in the right column are
commitments that show up later in the roadmap — they are not aspirational.

### Tier 1 — can kill the company

**R1. Cold-start liquidity (the marketplace chicken-and-egg).**
An empty map is worthless to a worker and a job nobody claims is worse than no app at all —
it actively burns a customer. This is the single most likely cause of death.
→ *Mitigation:* Launch **one metro, one ZIP cluster at a time**. Recruit 25–40 workers
*before* any customer acquisition spend. Guarantee early jobs: if no worker claims within
N hours, the platform pays a subsidy to make the job attractive, or we fulfill it through a
pre-contracted local crew. Budget this as CAC, not as loss. Ship a "service area" gate so the
app honestly says "not in your area yet — join the waitlist" instead of showing an empty map.

**R2. Worker misclassification (1099 vs. W-2).**
This is an existential legal risk in CA, MA, NJ, WA, and increasingly elsewhere. Lawsuits here
have cost gig companies nine figures.
→ *Mitigation:* The product must not exert control over *how* work is performed. Concretely,
this constrains features: workers set their own service radius and schedule, we never assign a
job, we never require a uniform, we never penalize declining a job, and points must never be
framed as employment performance management. **This is why "lose points for declining a job"
is not in the points system and never will be.** Legal review before launch in any state.

**R3. Strangers on private property + no insurance.**
A worker damages a window, hits a sprinkler head, injures themselves on a slope, or worse.
Without coverage, one incident ends the company.
→ *Mitigation:* Occupational-accident + general liability coverage for on-platform jobs
(Uber/Lyft use this model via companies like Zego or Sedgwick). Background checks via Checkr
before a worker can claim. Incident reporting flow. This is a launch blocker, not a V2 item.

**R4. Disintermediation.**
Customer and worker meet once, exchange numbers, and transact in cash forever. This is *the*
structural killer of home-services marketplaces — the repeat-purchase behavior that should
compound our revenue instead leaks off-platform.
→ *Mitigation:* Make on-platform genuinely better rather than trying to police it.
Recurring scheduling that just works, payment protection, a damage guarantee that only applies
to platform-booked jobs, and worker-side incentives that reward *retained customers on platform*
(repeat-customer points). Measure leakage directly: a worker with high completion but zero repeat
customers is a leakage signal worth investigating, not automatically punishing.

### Tier 2 — can cripple growth

**R5. Seasonality.** Mowing revenue in most US metros collapses November–March. A business
modeled on summer run-rate will run out of money in February.
→ Leaf removal (Oct–Dec), gutter cleaning, pressure washing, mulch (spring), light snow work,
and holiday light installation are how the category smooths. Build `ServiceCategory` as data
from day one — never hard-code the job list — so we can open seasonal categories without a
release. **This is already reflected in the data model.**

**R6. Customer-set pricing produces unclaimed jobs.** If a homeowner offers $20 for an acre,
nothing happens, and they conclude the app is broken.
→ Show a live price recommendation derived from yard size, job type, and local claim history
*during* job creation, with honest feedback ("jobs like this usually claim at $55–70; at $30
about 1 in 10 get claimed"). Then let them override. Track abandonment at this step as a
first-class funnel metric.

**R7. Apple's In-App Purchase rule vs. GrassAssassin Pro.**
Marketplace transactions for real-world services are exempt from IAP (App Store Guideline
3.1.3(e)) — that part is fine. But a **worker subscription** is a digital service sold in-app,
and Apple can credibly demand 30% of it. A 30% tax on Pro destroys its margin.
→ *Mitigation:* Sell Pro **on the web only** and never link to it from inside iOS (this is the
post-*Epic* permitted posture in the US, but it is jurisdiction-specific and keeps changing —
verify at submission time). Better still: make the Pro benefits mostly *earned* through
performance rather than purchased, which is both cheaper legally and better for trust. **Do not
build Pro into the MVP.** Flagged for legal review.

**R8. Chargebacks and "the work was never done."**
→ Geofenced check-in timestamps, mandatory before/after photos with EXIF and server-side
capture time, and in-app chat transcripts form the evidence package. Stripe dispute evidence
submission should be automated from these artifacts.

**R9. Gamification producing the wrong behavior.**
Points that reward speed produce rushed, dangerous work and damaged property. Leaderboards
that only reward volume mean a new worker can never rank and churns in week one.
→ Points reward *reliability and quality*, never raw speed. "Completed before deadline" is
capped and small. There is no points bonus for working at night or in unsafe heat. Leaderboards
are segmented so newcomers compete in a Rookie bracket. **Detailed in §6.**

### Tier 3 — manageable, but plan for them

**R10. Brand and naming.** "Assassin" carries real friction: App Store age-rating questions,
some payment processors' prohibited-content reviews, and ad-platform keyword rejections
(Meta and Google both flag violence-adjacent terms). It is also *memorable and good*, which is
why it is worth defending rather than abandoning. Mitigation: consistent grass/lawn imagery,
never a weapon in the icon, age rating 4+, and a one-line brand descriptor everywhere ("Yard
work, claimed.") that immediately resolves the ambiguity. **Also — spelling needs a decision;
see the open questions at the end.**

**R11. Photo storage cost and abuse.** Before/after photos on every job is a lot of bytes and a
vector for illegal content.
→ Client-side compression, aggressive lifecycle rules (full-res 90 days, thumbnails forever),
and automated moderation on upload.

**R12. Location privacy.** Publishing exact home addresses to a pool of unvetted workers would
be indefensible — the "single woman living alone, address visible to strangers" scenario is
both a safety failure and a press disaster.
→ Address masking is enforced **server-side at the query layer**, not in the client. The API
must be incapable of returning an exact address to a worker who has not claimed the job.
This is a hard architectural constraint and it is tested.

---

## 3. Opportunities worth building toward

1. **Recurring revenue is the actual business.** A one-time mow is a $9 net transaction.
   A biweekly mow converted for a season is ~13 transactions from one acquisition. Every
   product decision should push toward conversion-to-recurring. *This is the highest-leverage
   thing in the entire product* and it is why recurring jobs are in the MVP-adjacent tier
   rather than V2.
2. **Property graph as a moat.** After one visit we know yard size, gate code, dog, sprinkler
   locations, slope, and how long it actually took. That data makes every subsequent job on
   that property price better and claim faster than any competitor can match on day one.
3. **B2B / property managers.** A single property manager with 40 units is worth ~200
   consumer customers and has near-zero churn. Different sales motion, same supply pool.
4. **Worker tooling as retention.** Route batching ("3 jobs within 2 miles on Saturday"),
   earnings analytics, and tax-time 1099 summaries make us the app workers *keep*, which
   is how we win the supply side against GreenPal.
5. **Pricing intelligence.** Once we have claim-rate-versus-price data by geography and job
   type, we can quote instantly and accurately — the foundation for a future fixed-price
   "Instant Book" product that removes the last friction from the customer flow.

---

## 4. MVP definition

**The MVP thesis:** one metro, one loop, excellent.

> Customer posts yard job → nearby worker finds it on a map → claims it → does it →
> uploads proof → customer approves → worker gets paid → both rate each other.

Anything that does not make that loop work on launch day is not MVP. Ruthlessly.

### In scope for MVP

**Identity & accounts**
- Email + password auth, refresh-token rotation, password reset
- Phone verification (SMS OTP) — required for workers, optional for customers
- Single account, dual role (a user can be both customer and worker)
- Worker onboarding: profile, service radius, equipment, categories, Stripe Connect Express
  onboarding, background check gate

**Customer**
- Add property (address autocomplete, map pin adjust, yard size estimate)
- Post job: category, description, photos, size, deadline + optional time window, price,
  equipment provided, special instructions
- Price guidance during creation
- Saved payment method (Stripe SetupIntent — no raw card data touches us, ever)
- Track job status, in-app chat, approve completion, tip, rate, report a problem
- Cancel per policy

**Worker**
- Map view with clustered, priced markers of nearby available jobs
- List view with sort (distance / pay / newest / due soon / pay-per-hour) and filters
- Job detail with approximate location, payout, distance, deadline, customer rating
- **One-tap claim with guaranteed single-winner semantics**
- Status progression: En Route → Started → Completed, with photo proof
- Directions handoff, earnings screen, job history

**Platform**
- Job lifecycle state machine, enforced server-side
- PostGIS radius search with address masking
- Stripe Connect: charge on claim, hold, release on approval, transfer, payout
- Auto-approval after 24h of customer silence (with notification warnings first)
- Push notifications for the ~10 events that matter
- Points, ranks, and a weekly local leaderboard
- Admin: users, jobs, payments, refunds, disputes, service areas, **fee configuration**,
  category management, point-rule configuration
- Analytics events on the full funnel

**Quality bar**
- Automated tests for auth, job lifecycle, claim concurrency, payment state transitions,
  and privacy masking
- Responsive across phone / foldable / tablet / desktop
- Crash and error monitoring

### Explicitly NOT in MVP

Deferred to V1.1: recurring jobs, referrals, favorite/rehire, advanced worker analytics,
badges beyond rank, tipping presets tuning, in-app dispute resolution UI (handled by admin
+ email at first), featured/sponsored jobs.

Deferred to V2: GrassAssassin Pro subscription, business/multi-property accounts, instant
payout, commercial marketplace, route batching, worker-to-worker teams, equipment rental,
in-app navigation, seasonal bundles, loyalty program.

**Cut from the original brief, deliberately:**
- *In-app turn-by-turn navigation.* Deep-link to Google Maps / Apple Maps / Waze. Workers
  already have a preferred nav app and building this is months of work for negative value.
- *Worker identity verification beyond Stripe + Checkr.* Stripe Connect already does KYC;
  duplicating it is wasted effort and an extra abandonment step in onboarding.

---

## 5. Monetization

### The recommended model

**Take the fee from both sides, keep each visible number small.**

| Component | Rate | Configurable |
|---|---|---|
| Worker commission | **12%** of job price | ✅ admin, per-market |
| Customer service fee | **8%**, minimum $2.99 | ✅ admin, per-market |
| Minimum job price | **$25** | ✅ admin |
| Tips | **0% platform cut** | ✅ (but keep at 0) |

### Why both sides rather than one

A single-sided 20% commission makes the worker's number look brutal
("$60 job, you get $48"). Splitting it means the worker sees **12%** and the customer sees
**8%** — the same total economics, materially better perceived fairness on both sides.
Thumbtack and TaskRabbit both learned this the expensive way.

**Tips are never taxed by the platform.** The margin is trivial and the trust damage is not.
This should be a stated, public policy — it is cheap goodwill that competitors won't match.

### Unit economics, worked honestly

A $60 mow:

```
Customer pays            $60.00  job price
                        + $4.80  service fee (8%)
                        ─────────
                          $64.80  charged

Stripe (2.9% + $0.30)    -$2.18
Worker receives          -$52.80  ($60 less 12% commission)
                        ─────────
Platform net              $9.82   per job
Payout cost (ACH)        -$0.25
                        ─────────
NET CONTRIBUTION          $9.57   = 14.8% of GMV
```

Cross-checks that matter:

- **The $25 minimum exists because of the $0.30 fixed fee.** On a $25 job, net contribution
  is ~$3.60 and Stripe's fixed component eats 8% of our own margin. Below $25 the unit
  economics invert once support cost is included. Do not let anyone talk us out of the floor.
- **Break-even ≈ 1,050 jobs/month** against a $10k/month fixed cost base (infrastructure,
  Checkr, Twilio, insurance, one support contractor). At a realistic 6 jobs per active
  customer per season, that is roughly **1,400–1,800 active customers in one metro** — a
  plausible single-city target, which is the point of launching narrow.
- **Recurring changes everything.** The same customer converted to biweekly produces
  ~13 jobs a season, so CAC amortizes across ~$124 of contribution instead of ~$9.57.
  A 25% conversion-to-recurring rate is worth more than doubling top-of-funnel.

### Revenue lines, sequenced

1. **Marketplace commission + service fee** — MVP. This is the business.
2. **Featured job placement** — V1.1. Customer pays $3–5 to pin their job to the top of the
   list and give the marker a distinct treatment. Low build cost, pure margin. *Guardrail:
   featured affects sort position only — it never hides other jobs and never changes who is
   allowed to claim.*
3. **Recurring service** — V1.1. Not a separate fee; it multiplies transaction volume, which
   is more valuable than any new fee line.
4. **Business accounts** — V2. Multi-property dashboard, consolidated invoicing, net-30 terms.
   Charge a platform fee on volume rather than a seat license.
5. **Instant payout** — V2. 1.5% (min $0.50), passing through Stripe's ~1% cost. Genuine
   convenience, genuinely optional, and workers in this category value it highly.
6. **GrassAssassin Pro** — V2, **web-sold only**, pending the App Store analysis in R7.
7. **Commercial marketplace** — V2+. Different product, same supply graph.

### The line we do not cross

**No pay-to-win on the supply side.** A worker must never be able to *purchase* priority
access to jobs. The moment money buys claim priority, the map stops reflecting merit, good
workers leave, and job quality collapses. Rank benefits must be **earned**, and even earned
early-access must be time-boxed and narrow (see §6). Featured placement is a *customer*
product — it makes one job more visible to everyone, which is categorically different from
making one worker more privileged than another.

Every percentage above lives in the `platform_config` table and is editable from the admin
dashboard, per-market, with an audit log. Nothing is hard-coded.

---

## 6. Points, ranks, and leaderboards — designed against the failure modes

The brief asks for gamification to be "a major part" of the product. Agreed — but the default
implementation of gamification in a labor marketplace produces rushed work, gaming, and new-worker
churn. Here is the version that doesn't.

### Earning

| Event | Points | Note |
|---|---|---|
| Job completed | +100 | the backbone |
| Completed before deadline | +25 | capped, deliberately small |
| Five-star review | +20 | quality, not speed |
| Before/after photos | +10 | drives our dispute evidence |
| Fast customer response | +10 | responsiveness ≠ rushing |
| 5-job streak | +50 | |
| 10-job streak | +100 | |
| Difficulty bonus | +0–75 | scaled by yard size and category |
| **Repeat customer** | **+40** | *added — directly fights disintermediation* |

### Losing

| Event | Points |
|---|---|
| Cancel after claiming (>12h notice) | −50 |
| Cancel after claiming (<12h notice) | −150 |
| No-show | −300 |
| Late without communication | −75 |
| Verified customer complaint | −200 |

**Declining a job costs nothing.** Never. Both because it is the correct product
behavior and because penalizing it is direct evidence of employment-style control (see R2).

### Ranks

| Rank | Points | Earned benefits |
|---|---|---|
| Rookie | 0 | — |
| Trimmer | 500 | +2 mi radius |
| Lawn Ranger | 1,500 | verified badge, +5 mi radius |
| Yard Hunter | 4,000 | commission 12% → 11% |
| Grass Assassin | 10,000 | commission → 10%, profile placement |
| Elite Assassin | 25,000 | commission → 9%, 10-min early access to premium jobs |
| Legend | 60,000 | commission → 8%, concierge support |

Two safeguards that make this fair rather than entrenching:

1. **Rank requires a quality floor, not just points.** Grass Assassin and above additionally
   require ≥4.6 rating, ≥95% completion, and ≥90% on-time over a rolling 60 jobs. Points
   alone never buy rank. A high-volume, low-quality worker stalls at Yard Hunter.
2. **Early access is 10 minutes, tiered, and only on "premium" jobs** (top quartile payout).
   Every ordinary job is visible to every qualified worker simultaneously. A brand-new worker
   in good standing sees the same map as a Legend for the overwhelming majority of jobs.
   Additionally, **every worker's first 10 jobs are exempt from early-access delays entirely** —
   newcomers need wins to stay.

### Leaderboards

Local (ZIP cluster) / City / Weekly / Monthly / All-time — plus a **Rookie bracket** for
workers under 20 completed jobs, so newcomers compete with peers instead of losing to someone
with 1,200 jobs. Weekly boards reset, which is what makes them motivating; all-time is
prestige. Recalculated on a schedule, not on every write.

---

## 7. Open questions for the founder

Answers to these change what gets built; I have not guessed at them.
My recommendation leads each one.

**Q1. Brand spelling — "GrassAssassin" or "GrassAssissin"?**
The brief writes *GrassAssissin* throughout; the repository is *Grass_Assassin*.
→ **JARVIS RECOMMENDATION: "GrassAssassin"** (standard spelling). It is the correct English
word, it is what people will type into the App Store search bar, and the misspelling will
cost real organic discovery plus a permanent support burden. The whole codebase currently
assumes this spelling and it is trivial to change now and expensive later.

**Q2. Should workers see customer ratings before claiming?**
→ **JARVIS RECOMMENDATION: yes, show it.** Symmetric accountability is what makes both sides
behave, and workers accepting jobs sight-unseen on private property deserve the signal. The
cost is that low-rated customers get slower service — which is the correct incentive. One
refinement: hide it until a customer has ≥3 ratings, so a single bad first review doesn't
freeze someone out.

**Q3. Brand personality — premium, competitive, or humorous?**
→ **JARVIS RECOMMENDATION: premium with a competitive edge, humor only in micro-copy.**
Customers are inviting a stranger onto their property and handing over money; the surface
they see must feel trustworthy and expensive. Workers respond to the competitive layer.
The name is already funny — the design should not also be, or it reads as unserious exactly
when trust matters most.

**Q4. Launch market?**
→ Needed to configure the service-area gate, seed pricing, and prioritize seasonal categories.
No default recommendation — this depends on where you can physically recruit the first 30 workers.

**Q5. Customer-set price vs. platform-suggested fixed price?**
→ **JARVIS RECOMMENDATION: keep customer-set for MVP, with strong guidance.** It de-risks
launch (we do not yet have the data to price accurately) and it is the mechanism that
generates the pricing dataset which later enables Instant Book. Revisit at ~5,000 jobs.
