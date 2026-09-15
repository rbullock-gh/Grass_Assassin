# GrassAssassin

A location-based marketplace for yard work. A homeowner posts a job at their
property; nearby approved workers see it on a map and claim it; the work gets
done, the customer approves, the worker gets paid, and both sides rate each other.

---

## Status

**Phases 0–4 are built. The API is a working marketplace, the admin dashboard
is authenticated and can settle disputes, and the Expo app is written and
typechecked.**
See `docs/03-roadmap-and-team.md`.

| | |
|---|---|
| Tests passing | **832** (364 API · 214 mobile · 161 domain · 37 admin · 37 design · 19 client) plus **270 browser checks** (96 mobile screens · 64 admin screens · 54 auth · 25 dispute end-to-end · 17 revocation · 14 brute-force) |
| Database | PostgreSQL 16 + PostGIS 3.4 · 48 tables · 6 GIST indexes · 18 CHECK constraints |
| CI | green on typecheck, the full suite against real PostGIS, a structural migration-drift check, a mobile bundle on a cold cache, and an end-to-end smoke run against a live server. Two further jobs — rendering every mobile screen, and driving the admin dashboard's locks against a production build — are configured and pass locally but have not yet run on a GitHub runner |
| Verified end to end | post → search → claim → message → photo upload → geofenced start → complete → approve → pay → points → rate → tip → recurring, over real HTTP |
| Verified operationally | an admin changed the commission in the dashboard and the next job priced differently — no deploy, no restart |
| Verified visually | admin dashboard rendered in Chromium, light + dark + 390px mobile, zero console errors |
| Verified adversarially | admin sign-in driven in a browser: forged, tampered and expired sessions refused; a real customer and a real worker refused with their correct passwords; a revoked administrator loses access on the next request; guessing throttled per source without letting one attacker lock everyone out. Each with a negative control — removing the gate fails 20 of 54 checks, removing the per-request re-read fails exactly the 5 revocation checks |
| Verified visually (mobile) | every screen rendered in Chromium via the Expo web build — 96 screen × viewport × theme combinations (phone, Fold width, tablet, desktop; light and dark), signed in against the live API, with zero console errors, zero page errors, zero horizontal overflow and no unmatched routes |
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

pnpm -r test        # 1,019 tests (plus 11 in `pnpm test:scripts`); the API suite needs the test database
pnpm -r typecheck

pnpm dev:api        # http://localhost:4000 — /health, /v1/categories, /v1/leaderboard

pnpm --filter @grassassassin/mobile start  # Expo — needs a device or simulator
```

### On an actual phone

```bash
docker compose up -d db redis    # or point DATABASE_URL at your own PostGIS
pnpm demo
```

`pnpm demo` checks everything first and starts nothing until it all passes —
Node, pnpm, dependencies, a reachable database, secrets long enough to be
secrets, a free port — then migrates, seeds, starts the API and prints a QR
code. Install **Expo Go**, put the phone on the same wifi, and scan it. Sign in
as `customer1@grassassassin.test` or `worker1@grassassassin.test`, password
`GrassDemo123!`.

`pnpm demo --check` runs the checks and starts nothing.

The one thing worth understanding: the API has to advertise an address the
phone can route to. On a phone `localhost` is the phone, so a default
`PUBLIC_BASE_URL` produces an app that works until you take a photo and then
fails for a reason nothing on screen explains. The script finds this machine's
LAN address and passes it through. It refuses addresses a phone cannot reach —
docker bridges, VPN tunnels, loopback, public and documentation ranges — and
says so rather than handing over a URL that will time out. Override with
`pnpm demo --host 192.168.1.42`.

Expo Go is the fastest way to see the product and it is not the product: it
carries its own bundle identifier, shares one push certificate, and from SDK 53
does not deliver remote notifications at all. For something installable, there
are EAS profiles in `apps/mobile/eas.json`:

```bash
npx eas-cli build --profile preview --platform android   # an .apk you can sideload
npx eas-cli build --profile preview --platform ios       # TestFlight or ad-hoc
```

Those need an Expo account and, for iOS, an Apple Developer account. **They have
never been run** — see *What is not verified* in `docs/04-deployment.md`.

### The admin dashboard

It can change the platform commission and settle disputes, so it does not run
unauthenticated: without `ADMIN_SESSION_SECRET` it refuses to start in
production, and administrators sign in with their own accounts rather than a
shared password — which is what lets a dispute resolution record who decided it.

```bash
# Make the first administrator. Idempotent: an existing account is granted the
# role rather than duplicated.
pnpm --filter @grassassassin/api admin:create -- \
  --email you@example.com --password '...' --name 'Your Name'

ADMIN_SESSION_SECRET=at-least-32-characters-long \
API_BASE_URL=http://localhost:4000 \
ADMIN_SERVICE_TOKEN=at-least-32-characters-long \
  pnpm --filter @grassassassin/admin dev     # http://localhost:3001
```

`ADMIN_SERVICE_TOKEN` is only needed to resolve disputes. The refund is issued
by the API, which is the only process that should hold the payment provider's
credentials; the dashboard proves it is the dashboard with that token and names
the administrator who clicked, and the API checks that person really is one.

Leaving the secret unset runs it open locally, with a banner on every page
saying so.

### Checking the dashboard's locks actually lock

```bash
node scripts/admin-auth-check.mjs         # 54 checks: gating, cookie flags, forged
                                          # and expired sessions, open redirects
node scripts/admin-revocation-check.mjs   # 17 checks: suspending, banning, deleting or
                                          # demoting an admin ends access on the NEXT
                                          # request, not at cookie expiry
node scripts/admin-bruteforce-check.mjs   # 14 checks: guessing is throttled per source,
                                          # and one attacker cannot lock everyone out
```

All three run in CI against a production build. They need an administrator
account and a running dashboard; the revocation script mutates the database and
restores what it changed, so point it at a development one.

### Rendering every screen and checking what broke

Three of the worst defects this project has had were invisible to typecheck and
to the entire unit suite — the app could not bundle at all, every line of text
overlapped the one above it, and a worker's balance was rounded UP to more money
than they had. None are findable by reading; all three are obvious in a
screenshot.

```bash
pnpm --filter @grassassassin/mobile exec expo export --platform web --output-dir .web
node scripts/serve-web.mjs .web &
node scripts/render-check.mjs        # 96 combinations, ~3.5 minutes
```

Every screen at four widths (phone, Fold, tablet, desktop) in both themes,
signed in against the running API. Fails on a console error, a page error,
horizontal overflow, an unmatched route, or a screen that renders almost
nothing. Screenshots land in `.render-check/`.

This drives the Expo **web** build, which is not a phone: gestures, native maps,
the camera and SecureStore all behave differently and remain unproven here.

Copy `.env.example` to `.env` for the full variable list.

### Running the whole stack in containers

```bash
docker compose up --build     # PostGIS, Redis, migrations, API :4000, admin :3001
```

`docs/04-deployment.md` covers what runs where, which variables fail closed, how
migrations are applied, and — importantly — what has not been verified. The
images have never been built: there is no container runtime in the environment
this was written in. What *was* verified by hand is that the bundled API serves
the complete marketplace loop from a directory containing only `dist`, a pruned
`node_modules` and `prisma`, which is exactly what the image assembles. CI
builds both images and drives the marketplace through them, so the first run
will say whether the assembly is right.
