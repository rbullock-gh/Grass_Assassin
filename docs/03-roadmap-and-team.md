# GrassAssassin — Phased Plan & Agent Assignments
**Owner:** JARVIS

---

## Phased implementation plan

### Phase 0 — Foundation ✅ *(complete)*
Monorepo, TypeScript config, shared contracts package, database schema with PostGIS,
migrations running against real Postgres, CI.

### Phase 1 — Core loop 🔄 *(in progress)*
The spine: auth, properties, jobs, geo search with privacy masking, **atomic claim**,
job lifecycle state machine, photo upload contracts, and the test suite that proves the
claim is race-free. *Exit criteria: a job can be posted, found by radius, claimed by exactly
one of N concurrent workers, and driven through to CLOSED — all covered by passing tests.*

### Phase 2 — Money
Stripe Connect Express onboarding, SetupIntent on the customer side, capture-on-claim,
hold, release-on-approval, transfers, payouts, refunds, partial refunds, cancellation policy
engine, webhook handling with idempotency, and the double-entry ledger.
*Exit criteria: full money lifecycle passing against Stripe test mode, including failure paths.*

### Phase 3 — Gamification & automation
Points engine, rank calculation with quality floors, leaderboards (materialized views),
BullMQ workers for job matching, deadline reminders, auto-approval, reputation recalculation,
and fraud flagging.

### Phase 4 — Clients
Expo app (worker map first — it is the hardest and most important screen), customer post flow,
design system implementation, responsive layouts across all four size classes, Next.js admin.

### Phase 5 — Hardening & launch
Load testing (HULK), security review (BLACK WIDOW), accessibility audit, store assets,
EAS build pipeline, staging + production environments, monitoring, runbooks, legal review
(worker classification, insurance, ToS, privacy policy).

---

## The Avengers — assignments

| Agent | Domain | Owns in this project |
|---|---|---|
| **JARVIS** | Coordination | Requirements, sequencing, product decisions, founder checkpoints |
| **TONY STARK** | Architecture | Stack, data model, API design, state machine, module boundaries |
| **VISION** | QA & review | Code review, edge cases, test strategy, logic validation |
| **FRIDAY** | UI/UX | Flows, design system, responsive layouts, accessibility |
| **QUICKSILVER** | Performance | Query tuning, indexes, map rendering, caching, budgets |
| **BLACK WIDOW** | Security | Auth, authorization, privacy masking, payment security, fraud |
| **HAWKEYE** | Bug hunting | Broken interactions, layout defects, regressions |
| **THOR** | Infrastructure | CI/CD, environments, deployment, monitoring, backups |
| **HULK** | Stress testing | Load tests, **concurrent claim contention**, traffic spikes |
| **SPIDER-MAN** | UX testing | Usability review, step reduction, confusion hunting |
| **SHURI** *(added)* | Data & analytics | Event taxonomy, funnels, pricing intelligence, leaderboard math |
| **PEPPER POTTS** *(added)* | Trust, legal & ops | Worker classification, insurance, disputes, policy, App Store compliance |

Two additions beyond the roster in the brief. **SHURI** because analytics instrumented
after the fact is analytics that never happens, and the pricing dataset is a strategic asset.
**PEPPER POTTS** because R2 (worker misclassification), R3 (insurance), and R7 (App Store IAP)
are each capable of ending the company and none of them belong to an engineering discipline.

---

## The development loop

For every feature: **JARVIS defines → build → VISION reviews → HAWKEYE hunts →
BLACK WIDOW checks → SPIDER-MAN checks → QUICKSILVER measures → fix → retest.**

Standing rule for this project: *nothing is reported as working unless it has been executed.*
Where something cannot be verified in this environment, it is stated explicitly as unverified
rather than quietly assumed. Every status report in this repo separates
**tested** from **written but unverified**.

---

## Analytics event taxonomy (SHURI)

Instrumented from the first commit, because retrofitting is how you end up with three months
of unanswerable questions.

**Customer funnel:** `job_create_started` → `category_selected` → `property_selected` →
`date_selected` → `details_completed` → `price_entered` → `price_guidance_shown` →
`job_published` | `job_create_abandoned{step}`

**Worker funnel:** `map_viewed` → `job_marker_tapped` → `job_detail_viewed` →
`claim_attempted` → `claim_won` | `claim_lost{reason}` | `job_dismissed{reason}`

**Lifecycle:** `job_claimed` · `worker_en_route` · `work_started` · `work_completed` ·
`customer_approved` · `auto_approved` · `payment_released` · `tip_added` · `rating_submitted`

**The questions these answer:** % of posted jobs claimed · time-to-claim distribution ·
views-before-claim · abandonment step in job creation · decline reasons · repeat rate by
cohort · price-vs-claim-rate curve per market and category · completion time vs. estimate.

**Privacy:** no exact coordinates in analytics events — jobs are bucketed to ~1km geohash.
No PII in event properties. User IDs are pseudonymous. Opt-out is honored and DSAR-exportable.
