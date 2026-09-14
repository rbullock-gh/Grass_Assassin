# GrassAssassin

A location-based marketplace for yard work. A homeowner posts a job at their
property; nearby approved workers see it on a map and claim it; the work gets
done, the customer approves, the worker gets paid, and both sides rate each other.

---

## Status

**Phases 0–3 are complete and tested. The API is a working marketplace.**
Phase 4 (mobile and web clients) has not started. See `docs/03-roadmap-and-team.md`.

| | |
|---|---|
| Tests passing | **303** (86 domain · 186 API integration · 31 design) |
| Database | PostgreSQL 16 + PostGIS 3.4 · 48 tables · 6 GIST indexes · 18 CHECK constraints |
| Verified end to end | post → search → claim → work → approve → pay → points, over real HTTP |
| Not yet verified | the Stripe adapter itself (no credentials here), push delivery, mobile/web clients |

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
docs/
```

---

## Two things worth reading the code for

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

pnpm -r test        # 303 tests; the API suite needs the database
pnpm -r typecheck

pnpm dev:api        # http://localhost:4000 — /health, /v1/categories, /v1/leaderboard
```

Copy `.env.example` to `.env` for the full variable list.
