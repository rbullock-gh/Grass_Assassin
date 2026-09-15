# GrassAssassin

A location-based marketplace for yard work. A homeowner posts a job at their
property; nearby approved workers see it on a map and claim it; the work gets
done, the customer approves, the worker gets paid, and both sides rate each other.

---

## Status

**Phases 0–4 are built. The API is a working marketplace, the admin dashboard
is visually verified, and the Expo app is written and typechecked.**
See `docs/03-roadmap-and-team.md`.

| | |
|---|---|
| Tests passing | **759** (144 domain · 327 API · 214 mobile · 37 design · 19 client · 18 admin) |
| Database | PostgreSQL 16 + PostGIS 3.4 · 48 tables · 6 GIST indexes · 18 CHECK constraints |
| CI | green — typecheck, full suite against real PostGIS, structural migration-drift check, and an end-to-end smoke run against a live server |
| Verified end to end | post → search → claim → message → photo upload → geofenced start → complete → approve → pay → points → rate → tip → recurring, over real HTTP |
| Verified operationally | an admin changed the commission in the dashboard and the next job priced differently — no deploy, no restart |
| Verified visually | admin dashboard rendered in Chromium, light + dark + 390px mobile, zero console errors |
| Verified visually (mobile) | every screen rendered in Chromium via the Expo web build — 60 screen × viewport × theme combinations (phone, Fold width, tablet, desktop; light and dark), signed in against the live API, with zero console errors, zero page errors, zero horizontal overflow and no unmatched routes |
| **Not verified** | the Stripe adapter (no credentials here), push delivery, device geocoding, and **native behaviour on a real iOS/Android device** — the app bundles and renders, but React Native Web is not the same runtime as a phone, so gestures, maps, the camera and SecureStore remain unproven |

Mobile app surfaces: worker onboarding, map with all seven filters, job detail,
claim, before/after photo capture, earnings, public pro profile, leaderboards,
customer home, five-step post flow, job tracking with approve/tip/rate/recurring,
listing photos, add property, in-app messaging, and the signed-out flow.

The full loop has been executed against a running server, not just unit-tested:
a customer posts a job, a worker finds it on the map, claims it, the second
worker is correctly told they lost, the work progresses through a geofenced
start and photo gates, the customer approves, the worker is paid, and the
double-entry ledger nets to exactly zero.

Nothing above is claimed to work without having been executed. Anything unbuilt
is stated as unbuilt.

---

## Documentation

Read these in order — they explain every decision in the code.

| Doc | Contents |
|---|---|
| [`docs/00-strategy.md`](docs/00-strategy.md) | Risk register, MVP scope with explicit cuts, monetization with worked unit economics, points/rank design |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Stack evaluation, map provider decision, system architecture, job state machine, the single-winner claim, privacy model |
| [`docs/02-flows-and-screens.md`](docs/02-flows-and-screens.md) | Customer and worker flows, screen map, responsive strategy, notification matrix |
| [`docs/03-roadmap-and-team.md`](docs/03-roadmap-and-team.md) | Phased plan, agent assignments, analytics taxonomy |

---

## Layout

```
apps/
  api/                    Fastify + Prisma + PostGIS
    prisma/schema.prisma  48-table data model
    prisma/migrations/    init + spatial indexes and constraints
    prisma/seed.ts        categories, ranks, point rules, demo marketplace
    src/http/             Fastify server, routes, rate limiting
    src/modules/
      auth/               argon2 + JWT with refresh rotation & reuse detection
      jobs/claim.ts       ← the single-winner claim
      jobs/lifecycle.ts   transitions, geofencing, photo gates, sweepers
      jobs/repository.ts  atomic job/property inserts with geography
      geo/job-search.ts   ← PostGIS search with address masking
      payments/           provider port, Stripe adapter, settlement, ledger
      gamification/       points, reputation, rank resolution
packages/
  shared/                 domain logic shared by every client and the server
    src/domain/           state machine · money · points
    src/geo/              distance · privacy offset
    src/contracts/        zod wire contracts
  design/                 design tokens with verified WCAG contrast
  client/                 typed API client shared by mobile, web, and admin
apps/
  admin/                  Next.js operations dashboard
  mobile/                 Expo app — map, post flow, job tracking, messaging, leaderboards
docs/
```

---

## Four things worth reading the code for

**The claim** (`apps/api/src/modules/jobs/claim.ts`) — when N workers tap CLAIM on
the same job at the same instant, exactly one wins. This is done with a single
conditional `UPDATE` whose `WHERE status = 'POSTED'` predicate *is* the lock, so
there is no check-then-act window at all. A negative-control test runs the naive
implementation through the identical harness and asserts that it *does*
double-book — without it, a green concurrency test would only prove the harness
never created contention.

**Address privacy** (`apps/api/src/modules/geo/job-search.ts`) — a worker who has
not claimed a job cannot obtain the exact address, because the search query never
selects it. Masked data is never loaded rather than filtered after loading. The
boundary is asserted over HTTP as well as at the query layer.

**The ledger** (`apps/api/src/modules/payments/ledger.ts`) — `transactions`
records intent; `ledger_entries` records effect, as balanced double-entry lines.
`postEntry` refuses to write anything that does not sum to zero, because a
lopsided write corrupts the books silently while looking like success.

**Message screening** (`packages/shared/src/domain/messages.ts`) — phone
numbers, emails, payment handles and "let's do this off the app" are flagged for
human review and the message is **delivered anyway**. Blocking is wrong twice
over: the false positives are the most ordinary messages in the product
("$120.00 for front and back, gate code 4417" — prices and street addresses are
stripped before the phone check for exactly this reason), and a worker whose
legitimate message vanishes switches to SMS, which is the leak the block was
meant to prevent.

Demo credentials after seeding: `customer1@grassassassin.test` /
`worker1@grassassassin.test`, password `GrassDemo123!`

---

## Local development

```bash
pnpm install

# PostgreSQL 16 with PostGIS 3 must be running
createdb grassassassin_dev
echo 'DATABASE_URL=postgresql://user:pass@localhost:5432/grassassassin_dev' > apps/api/.env

pnpm --filter @grassassassin/api db:deploy    # applies migrations, creates the postgis extension
pnpm --filter @grassassassin/api db:generate

pnpm --filter @grassassassin/api db:seed     # reference data + a demo marketplace

# The integration suite TRUNCATES every table, so it runs against its own
# database and refuses to start against anything not named as a test database.
# This is deliberate: a destructive suite should not be one typo from a real URL.
createdb grassassassin_test
DATABASE_URL=postgresql://user:pass@localhost:5432/grassassassin_test \
  pnpm --filter @grassassassin/api db:deploy

pnpm -r test        # 687 tests; the API suite needs the test database
pnpm -r typecheck

pnpm dev:api        # http://localhost:4000 — /health, /v1/categories, /v1/leaderboard

pnpm --filter @grassassassin/admin dev     # http://localhost:3001
pnpm --filter @grassassassin/mobile start  # Expo — needs a device or simulator
```

### Rendering every screen and checking what broke

Three of the worst defects this project has had were invisible to typecheck and
to the entire unit suite — the app could not bundle at all, every line of text
overlapped the one above it, and a worker's balance was rounded UP to more money
than they had. None are findable by reading; all three are obvious in a
screenshot.

```bash
pnpm --filter @grassassassin/mobile exec expo export --platform web --output-dir .web
node scripts/serve-web.mjs .web &
node scripts/render-check.mjs        # 84 combinations, ~3.5 minutes
```

Every screen at four widths (phone, Fold, tablet, desktop) in both themes,
signed in against the running API. Fails on a console error, a page error,
horizontal overflow, an unmatched route, or a screen that renders almost
nothing. Screenshots land in `.render-check/`.

This drives the Expo **web** build, which is not a phone: gestures, native maps,
the camera and SecureStore all behave differently and remain unproven here.

Copy `.env.example` to `.env` for the full variable list.
