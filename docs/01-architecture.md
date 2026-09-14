# GrassAssassin — Technology Stack & System Architecture
**Owner:** TONY STARK (Architecture) · Reviewed by BLACK WIDOW, QUICKSILVER, THOR

---

## 1. Stack decisions

The brief proposed a stack and asked us to evaluate rather than blindly follow it. Most of it
survives scrutiny. Three things change. Each decision below states the alternative considered
and why it lost, so the reasoning can be re-litigated later when conditions change.

### Client — React Native + Expo + TypeScript ✅ *(accepted)*

One codebase for iOS, Android, and (with care) web, with over-the-air updates for JS-only
fixes — which matters enormously for a marketplace where a pricing bug needs to be fixed in
minutes, not in a 48-hour App Store review cycle.

Expo specifically (not bare RN) because EAS Build removes the entire Xcode/Gradle
signing-and-provisioning burden, and Expo Router gives file-based routing with typed links.

*Considered and rejected:* **Flutter** — excellent, genuinely better rendering performance,
but the mapping ecosystem is weaker, the hiring pool is smaller, and we'd give up code sharing
with the web admin. **Native iOS + Android** — best quality ceiling, roughly 2.2× the build
cost; not justifiable pre-product-market-fit.

### Web — Next.js (App Router), *not* Expo Web ⚠️ *(changed)*

The brief suggested sharing as much as practical. There is a limit, and the desktop
experience is where it bites.

Expo Web renders React Native primitives into DOM elements. It works, but it produces poor
SEO, a heavy bundle, and layouts that feel like a stretched phone app — which is precisely
the failure mode the brief explicitly forbids for desktop.

So: **Next.js owns the marketing site, the admin dashboard, and the customer web app.**
Code sharing happens at the layer where it is actually valuable — `@grassassassin/shared`
(zod schemas, types, domain logic, pricing, state machine) is consumed identically by mobile,
web, and server. Presentation is not shared, and should not be.

### Backend — Node + TypeScript + **Fastify** ✅ *(accepted, framework chosen)*

Same language as the client means shared validation schemas and one hiring profile.

Fastify over **NestJS**: Nest's decorator/DI machinery buys structure that a 3–8 person team
does not yet need, at the cost of indirection that makes performance work harder. Fastify is
roughly 2× the throughput on JSON workloads, and its schema-first design lets one zod schema
serve as runtime validation, TypeScript type, *and* OpenAPI documentation. If the team reaches
~20 engineers and module boundaries start eroding, migrating to Nest is a well-trodden path.

*Considered and rejected:* **Go** — better raw performance and concurrency, but loses schema
sharing with the client, which is worth more than the CPU at our scale. **tRPC** — superb DX,
but we need a stable versioned public API surface for Stripe webhooks, future partner
integrations, and mobile clients that users do not update; tRPC's tight client-server coupling
fights that.

### Database — PostgreSQL + PostGIS ✅ *(accepted)*

Non-negotiable and correct. PostGIS gives real spheroidal distance, `ST_DWithin` with GIST
index support, and radius search that stays fast as the jobs table grows. The naive
alternative — bounding-box filter plus in-application haversine — is fine at 1,000 jobs and
falls over well before 100,000.

> **Verified in this environment:** PostgreSQL 16.13 with PostGIS 3.4 (GEOS + PROJ) is
> installed and running, and every spatial query in this repo has been executed against it.

### ORM — **Prisma for schema/migrations/CRUD + raw parameterized SQL for spatial** ⚠️ *(nuanced)*

This is the most genuinely debatable call in the stack, so here is the honest version.

Prisma **does not support PostGIS geography types**. They must be declared
`Unsupported("geography(Point,4326)")`, which means Prisma Client cannot read or write them and
every spatial query must be raw SQL.

That is a real wart. Two ways to respond:

- **Drizzle ORM** — SQL-first, supports custom column types cleanly, lighter runtime. Honestly
  the better *technical* fit for a geo-heavy app.
- **Prisma + raw SQL escape hatch** — Prisma Migrate is the strongest migration tooling in the
  ecosystem (shadow-database drift detection has caught real production incidents), the
  generated types are excellent for the 90% of queries that are ordinary CRUD, and the hiring
  pool is much larger.

**Decision: Prisma**, with all spatial access confined to a single `geo/` module using
`$queryRaw` with tagged-template parameterization (which is SQL-injection-safe). The wart is
contained to roughly six queries that we want hand-tuned anyway. Revisit if spatial logic
grows past ~20 queries.

### The rest

| Concern | Choice | Why |
|---|---|---|
| Queue / scheduling | **BullMQ + Redis** | Notifications, leaderboards, recurring jobs, auto-approval, deadline reminders. Mature, good observability, supports delayed + repeatable jobs natively. |
| Payments | **Stripe Connect (Express)** | Only serious option for a US marketplace. Express balances onboarding friction against KYC obligations we do not want to own. |
| Object storage | **Cloudflare R2** | S3-compatible; zero egress fees. Job photos are read far more than written, so egress dominates — this is materially cheaper than S3. |
| Push | **Expo Notifications** → FCM/APNs | Expo's service is free and fast to integrate; the abstraction lets us move to direct FCM/APNs at scale without touching call sites. |
| SMS / OTP | **Twilio Verify** | Handles rate limiting and fraud heuristics so we don't have to. |
| Background checks | **Checkr** | Standard for gig platforms, good API. |
| Email | **Resend** | Good DX, React Email templates. |
| Cache | **Redis** | Same instance as BullMQ initially. |
| Auth | **Self-hosted JWT + argon2id** | Access (15 min) + rotating refresh (30 day) with reuse detection. Auth0/Clerk priced per MAU is punitive for a marketplace with many low-frequency users. |
| Monitoring | **Sentry** + OpenTelemetry | Crashes, traces, and performance in one place. |
| Analytics | **PostHog** | Self-hostable, EU-hosting option, product analytics + feature flags together. |

---

## 2. Map provider — the decision and the reasoning

The brief asked us to research this and explain the call. The answer is **not** a single
provider, and the reason is that "rendering a map" and "turning a typed address into a precise
coordinate" are different problems with different best-in-class answers.

### What we actually need

1. Render a styled, branded map with hundreds of clustered price markers, at 60fps, on a
   mid-range Android phone.
2. Convert a homeowner's typed address into an exact rooftop coordinate. **A wrong geocode
   means a worker mows the wrong lawn** — a catastrophic, unrecoverable trust failure.
3. Autocomplete addresses fast enough that job creation does not stall at the highest-drop-off
   step in the funnel.
4. Hand off navigation once a job is claimed.
5. Not go bankrupt on per-load pricing.

### Evaluation

| | Google Maps | Mapbox | Apple Maps |
|---|---|---|---|
| US residential geocoding | **Best in class** | Good, weaker on new/rural parcels | Good on iOS |
| Address autocomplete | **Best in class** (Places) | Decent | iOS-only API |
| Map styling / brand control | Limited | **Excellent** (Studio, vector styles) | Very limited |
| Clustering perf (RN) | Adequate | **Excellent** (native GL, GeoJSON source clustering) | N/A cross-platform |
| Cross-platform parity | Good | **Excellent** | ❌ iOS only |
| Cost at scale | Expensive per-load | **Cheaper** (MAU-based) | Free |
| Offline / vector tiles | Limited | **Yes** | No |

### Decision

> **Mapbox for rendering. Google Places + Geocoding for address entry.
> Native app deep-link for navigation. All three behind a provider interface.**

**Why Mapbox renders:** the worker map is our core screen and it needs custom styling (a
desaturated base so green price markers pop), high-performance clustering of hundreds of
markers, and identical behavior on iOS, Android, and web. Mapbox's MAU-based pricing is also
far kinder than Google's per-load pricing for a map users open many times a day — which is
exactly the usage pattern we are designing for.

**Why Google geocodes:** this is where being second-best has a real-world cost measured in
wrong lawns. Google's US residential coverage — especially new construction and unusual rural
addressing — is meaningfully better, and Places Autocomplete with session tokens is both the
best UX and reasonably priced. We spend money precisely where errors are unrecoverable.

**Why not Apple Maps:** no Android or web story. Disqualifying for a cross-platform product,
regardless of quality on iOS.

**Why deep-link navigation:** building turn-by-turn is months of work to produce something
worse than what is already on the worker's phone. We hand off to their preferred app and
spend that time on the claim flow instead.

**Abstraction:** `packages/shared/src/geo/provider.ts` defines `GeocodingProvider` and
`MapProvider`. Switching Google → Mapbox geocoding becomes a config change, not a refactor.
Given how often mapping vendors change pricing, this is cheap insurance.

**Cost guardrails:** cache geocoding results permanently keyed by normalized address
(addresses do not move); use Places session tokens so an autocomplete session bills once;
debounce autocomplete at 300ms; never geocode on every keystroke.

---

## 3. System architecture

```
┌───────────────┐   ┌───────────────┐   ┌────────────────┐
│  Mobile App   │   │   Web App     │   │     Admin      │
│ Expo / RN     │   │  Next.js      │   │   Next.js      │
│ iOS · Android │   │  customer     │   │  staff only    │
└───────┬───────┘   └───────┬───────┘   └───────┬────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │  HTTPS / JSON · JWT
                    ┌───────▼────────┐
                    │  API Gateway   │  Fastify
                    │  · authn/authz │  rate limiting
                    │  · validation  │  request tracing
                    └───────┬────────┘
        ┌───────────┬───────┼────────┬────────────┬──────────┐
        │           │       │        │            │          │
   ┌────▼───┐ ┌─────▼──┐ ┌──▼────┐ ┌─▼──────┐ ┌───▼────┐ ┌───▼────┐
   │ Identity│ │  Jobs  │ │Payment│ │Messaging│ │Gamify  │ │ Admin  │
   │ auth    │ │lifecycle│ │Stripe │ │ chat    │ │points  │ │ config │
   │ profiles│ │ CLAIM  │ │ledger │ │ push    │ │ranks   │ │ moder. │
   └────┬────┘ └────┬───┘ └───┬───┘ └────┬────┘ └───┬────┘ └───┬────┘
        └───────────┴─────────┼──────────┴──────────┴──────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
  ┌─────▼──────┐      ┌───────▼──────┐      ┌───────▼──────┐
  │ PostgreSQL │      │    Redis     │      │  Cloudflare  │
  │  + PostGIS │      │ cache+BullMQ │      │      R2      │
  └────────────┘      └───────┬──────┘      └──────────────┘
                              │
                     ┌────────▼─────────┐
                     │  Worker Process  │
                     │ · job matching   │
                     │ · deadline alerts│
                     │ · auto-approval  │
                     │ · leaderboards   │
                     │ · recurring jobs │
                     │ · payouts        │
                     │ · fraud scoring  │
                     └──────────────────┘
```

**Modular monolith, not microservices.** One deployable, strict internal module boundaries,
one database. At our scale microservices would add distributed-transaction problems to a
system whose hardest requirement — atomic job claiming — is *trivially* solved by a single
Postgres transaction and genuinely hard across a network. The module boundaries above are
drawn so that if a piece ever needs to be extracted, the seam already exists.

**Two processes, one codebase:** the API process serves requests; the worker process drains
BullMQ queues. They share domain code and scale independently — traffic spikes hit the API,
whereas leaderboard recalculation hits the worker.

---

## 4. The job lifecycle state machine

Every transition is enforced server-side. The client's job is to *display* state, never to
decide it.

```
                    ┌─────────┐
                    │  DRAFT  │
                    └────┬────┘
                         │ publish (payment method required)
                    ┌────▼────┐
        ┌───────────│ POSTED  │◄──────────┐
        │           └────┬────┘           │ payment failed
        │                │ claim          │ / claim expired
        │           ┌────▼──────────────┐ │
        │           │ CLAIM_PENDING_PAY │─┘
        │           └────┬──────────────┘
        │                │ payment captured
        │           ┌────▼────┐
        │  cancel   │ CLAIMED │
        │  ┌────────└────┬────┘
        │  │             │ worker en route
        │  │        ┌────▼──────┐
        │  │        │ EN_ROUTE  │
        │  │        └────┬──────┘
        │  │             │ start (geofence check)
        │  │        ┌────▼──────────┐
        │  │        │ IN_PROGRESS   │
        │  │        └────┬──────────┘
        │  │             │ complete + after photos
        │  │        ┌────▼──────────────┐
        │  │        │ PENDING_APPROVAL  │
        │  │        └────┬──────────┬───┘
        │  │   approve   │          │ dispute
        │  │  (or 24h    │     ┌────▼────┐
        │  │   auto)     │     │DISPUTED │
        │  │        ┌────▼───┐ └────┬────┘
        │  │        │APPROVED│      │ admin resolves
        │  │        └────┬───┘      │
        │  │             │ transfer │
        │  │        ┌────▼───┐      │
        │  │        │  PAID  │◄─────┘
        │  │        └────┬───┘
        │  │             │ both rate
        │  │        ┌────▼────┐
        │  │        │ CLOSED  │
        │  │        └─────────┘
        ▼  ▼
   ┌───────────┐         ┌──────────┐
   │ CANCELLED │         │ EXPIRED  │  deadline passed unclaimed
   └───────────┘         └──────────┘
```

`CLAIM_PENDING_PAYMENT` is the subtle and important one, and it exists because of a real
failure mode: if we marked a job `CLAIMED` and *then* charged the card, a declined card would
leave a worker believing they had work that does not exist. If we charged first and then
claimed, two workers could both be charged for one job.

So the claim **atomically reserves** the job into `CLAIM_PENDING_PAYMENT` — which only one
worker can ever win — and payment is attempted against that reservation. On success the job
moves to `CLAIMED`; on failure or on a 90-second TTL expiry, it returns to `POSTED` and
becomes claimable again. The reservation is the concurrency primitive; the payment is an
ordinary fallible side effect that cannot corrupt it.

---

## 5. Single-winner claim — the concurrency design

The brief names this as a critical requirement, and it is the piece most likely to be built
wrong. Here is what does *not* work and what does.

**Naive (broken):**
```ts
const job = await db.job.findUnique({ where: { id } })
if (job.status === 'POSTED') {                 // ← two workers both pass here
  await db.job.update({ where: { id }, data: { status: 'CLAIMED', workerId } })
}
```
Classic check-then-act. Both requests read `POSTED`, both write, last writer wins, two workers
are told they got the job. Under Postgres READ COMMITTED this happens readily under real load.

**What we do — conditional update (compare-and-set):**
```sql
UPDATE jobs
   SET status = 'CLAIM_PENDING_PAYMENT',
       claimed_by_worker_id = $2,
       claim_expires_at = now() + interval '90 seconds'
 WHERE id = $1
   AND status = 'POSTED'          -- ← the guard IS the lock
RETURNING id;
```

The `WHERE status = 'POSTED'` predicate makes the read and the write a single atomic
statement. Postgres takes a row lock for the duration; the second transaction blocks, then
re-evaluates the predicate against the *updated* row, finds `CLAIM_PENDING_PAYMENT`, matches
zero rows, and returns no rows. **Exactly one caller gets a row back. There is no race window
at all** — not a small one, none.

This beats the alternatives on the merits:
- *`SELECT ... FOR UPDATE` then update* — correct, but two round trips and a longer lock hold.
- *`SERIALIZABLE` isolation* — correct, but pushes the failure to commit time as a
  serialization error the application must retry, and costs throughput globally.
- *Redis distributed lock* — adds a second source of truth that can disagree with the database.
  Never introduce a distributed lock to solve a problem one SQL statement already solves.

Proven by an automated test that fires concurrent claims at a single job against real
PostgreSQL and asserts exactly one winner. See `apps/api/src/modules/jobs/claim.test.ts`.

---

## 6. Address privacy — enforced at the query layer

R12 requires that a worker who has not claimed a job cannot obtain the exact address. Client-side
hiding is not a control — anyone can read the API response. So the guarantee is structural:

- Jobs carry **two** geography columns: `exact_location` and `approx_location`.
- `approx_location` is computed **once at write time** by offsetting the exact point by a
  deterministic, per-job random bearing at 100–250m. It is *not* computed per-request, because
  a fresh random offset on each request would let an attacker average many responses to
  triangulate the true point.
- The public job-search query selects `approx_location` and **never selects the exact column
  or the street address at all** — masked data is not filtered out after the fact, it is never
  loaded.
- Exact location and full address are served only by a separate endpoint that verifies the
  requesting worker holds the active claim.

Verified by automated test: a non-claiming worker's response is asserted to contain no street
address and no exact coordinate.

---

## 7. Performance plan (QUICKSILVER)

| Risk | Mitigation |
|---|---|
| Map query slow as jobs grow | GIST index on `approx_location`; `ST_DWithin` (index-assisted) never `ST_Distance` in `WHERE`; hard `LIMIT`; cursor pagination |
| Marker overdraw on the map | Mapbox GeoJSON source-level clustering (native, not JS); viewport-bounded queries; 300ms debounce on pan |
| N+1 on job lists | Explicit `include`, single aggregate query for worker stats |
| Leaderboard recompute cost | Materialized view refreshed on a schedule, never computed per request |
| Cold start on mobile | Expo Router lazy routes, skeleton screens, optimistic claim UI |
| Photo upload on bad connections | Client-side resize to ≤1600px, presigned direct-to-R2 upload (never proxied through the API), resumable, background queue |
| Push fan-out on job post | Batched, queued, geo-pre-filtered by worker service radius |

**Budgets:** job search p95 < 150ms · claim p95 < 250ms · map interactive < 1.5s on a
mid-range Android · app cold start < 2.5s.

---

## 8. Security posture (BLACK WIDOW)

- **No card data ever touches our servers.** Stripe Elements / Payment Sheet only; we store
  Stripe IDs and nothing else. PCI scope stays at SAQ-A.
- argon2id password hashing; access tokens 15 min; refresh tokens rotate with **reuse
  detection** (a replayed refresh token revokes the whole family — the standard defense
  against token theft).
- Authorization checked per resource on every request; no endpoint infers permission from a
  client-supplied role.
- Rate limits: auth endpoints per-IP *and* per-account; claim endpoint per-worker; photo
  upload per-job.
- All spatial raw SQL uses tagged-template parameterization — no string interpolation, ever.
- Stripe webhooks: signature verification plus idempotency keys on every mutation.
- PII encrypted at rest; exact addresses and phone numbers access-logged for audit.
- Photo uploads: content-type allowlist, magic-byte sniffing, size caps, automated moderation.
- `AuditLog` on every admin action and every money movement.
