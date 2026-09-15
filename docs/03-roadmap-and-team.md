# GrassAssassin — Phased Plan & Agent Assignments
**Owner:** JARVIS

---

## Phased implementation plan

### Phase 0 — Foundation ✅ *(complete)*
Monorepo, TypeScript config, shared contracts package, database schema with PostGIS,
migrations running against real Postgres, CI.

### Phase 1 — Core loop ✅ *(complete)*
The spine: auth, properties, jobs, geo search with privacy masking, **atomic claim**,
job lifecycle state machine, photo upload contracts, and the test suite that proves the
claim is race-free. *Exit criteria: a job can be posted, found by radius, claimed by exactly
one of N concurrent workers, and driven through to CLOSED — all covered by passing tests.*
**Met.** The claim is proven single-winner under real concurrency against PostgreSQL, and
the whole loop runs end to end over HTTP in CI on every change.

### Phase 2 — Money ✅ *(complete, except against real Stripe)*
Stripe Connect Express onboarding, SetupIntent on the customer side, capture-on-claim,
hold, release-on-approval, transfers, payouts, refunds, partial refunds, cancellation policy
engine, webhook handling with idempotency, and the double-entry ledger.
*Exit criteria: full money lifecycle passing against Stripe test mode, including failure paths.*
**Partially met.** Every path passes against the fake provider, including declines, expired
authorizations, replayed webhooks, partial refunds and dispute settlement, with the ledger
proven to balance. The Stripe adapter is written and has never been given credentials, so
Stripe's own semantics remain unverified — that is the gap, and it is the real exit criterion.

### Phase 3 — Gamification & automation ✅ *(complete)*
Points engine, rank calculation with quality floors, leaderboards (materialized views),
BullMQ workers for job matching, deadline reminders, auto-approval, reputation recalculation,
and fraud flagging.

### Phase 4 — Clients ✅ *(built; native runtime unproven)*
Expo app (worker map first — it is the hardest and most important screen), customer post flow,
design system implementation, responsive layouts across all four size classes, Next.js admin.
Every screen renders in Chromium at four widths in both themes on every CI run. The admin is
authenticated, can settle disputes, and has its locks driven by a browser. What is NOT proven
is a real phone: gestures, native maps, the camera and SecureStore behave differently under
React Native than under React Native Web, and none of them have run on a device.

### Phase 5 — Hardening & launch 🔄 *(started)*
Load testing (HULK), security review (BLACK WIDOW), accessibility audit, store assets,
EAS build pipeline, staging + production environments, monitoring, runbooks, legal review
(worker classification, insurance, ToS, privacy policy).

Done so far: a security review of the branch, admin authentication with per-request
revocation and sign-in throttling, container images and a compose stack for the whole
system (`docs/04-deployment.md`), CI that renders every screen and drives the admin's
locks, a load test of the claim race and the map with numbers written down
(`docs/04-deployment.md`), and an accessibility audit that measures what is actually
painted — both apps are at zero findings and the audit runs in CI.

Also closed since: push notifications actually deliver (device registration, an
Expo adapter that prunes dead tokens, and the app side), and the trust-and-safety
loop is joined up — a person can be reported and blocked, blocks are enforced in
job search AND messaging, and an administrator can act on a report from a queue
that is no longer permanently empty.

Not started: the EAS build pipeline, monitoring, runbooks, and everything legal
— worker classification, insurance, ToS, privacy policy. Legal is the item most
likely to actually gate a launch, and it is the one item on this list that no
amount of engineering closes.

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
