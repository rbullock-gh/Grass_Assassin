# Deployment

What runs in production, how it is built, and the things that will bite you.

## The shape of it

Four processes and two stores:

| | |
|---|---|
| **API** (`apps/api`) | Fastify. The only process holding payment credentials. Stateless; scale horizontally. |
| **Admin** (`apps/admin`) | Next.js. Reads the database directly for its own pages; sends anything that moves money to the API. |
| **Mobile** (`apps/mobile`) | Expo. Shipped through the app stores and OTA updates, not deployed here. |
| **Worker** | The same API image, run with the queue consumer enabled. |
| **PostgreSQL 16 + PostGIS 3.4** | Not optional. Job search is `ST_DWithin` against a `geography` column with a GIST index; the schema will not migrate without the extension. |
| **Redis** | BullMQ. Without it the API falls back to an in-memory queue and says so on startup — reminders, leaderboard rebuilds and recurring jobs silently stop happening. |

## Building

```bash
docker build -f apps/api/Dockerfile   -t grassassassin-api   .
docker build -f apps/admin/Dockerfile -t grassassassin-admin .
```

Both are multi-stage and run as a non-root user. The build context is the
repository root — the workspace packages are part of both builds.

### Why the API bundles

`tsc` alone produced a `dist` that could not start. The workspace packages ship
TypeScript source (`@grassassassin/shared`'s entry point is literally
`src/index.ts`), so the emitted JavaScript imported files Node cannot load and
the server died on its first import. The typecheck passed, the build passed, and
the start script had never been run.

`apps/api/build.mjs` bundles with esbuild, inlining the workspace packages so
there is no cross-package resolution left at runtime. Registry dependencies stay
external and are installed normally: bundling argon2 or the Prisma engines
breaks them, and patching a CVE in a bundled dependency means a rebuild rather
than an install.

### The Prisma client

`pnpm deploy --prod` gives a pruned tree with `@prisma/client` but **not** the
generated client, and it cannot generate one for itself — the generator needs
the CLI, which by then has been pruned. `apps/api/scripts/stage-prisma-client.mjs`
resolves where the generator actually wrote it and copies it into the pruned
tree. The Prisma CLI itself is a runtime dependency rather than a dev one, so
the image can run `prisma migrate deploy`.

## Migrations

Run as a one-shot task **before** the new version starts, never from application
startup — two replicas booting at once would race to migrate the same database.

```bash
docker run --rm -e DATABASE_URL=... grassassassin-api \
  npx prisma migrate deploy --schema prisma/schema.prisma
```

Migrations must be backward compatible for the length of a rollout, because both
versions run at once. Add columns nullable, backfill, then tighten in a later
release. CI checks for schema drift structurally rather than by diffing text.

## Configuration

Every variable is in `.env.example`. The ones that fail closed, deliberately:

| Variable | If missing in production |
|---|---|
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | API refuses to start |
| `STRIPE_SECRET_KEY` | API refuses to start |
| `ADMIN_SESSION_SECRET` | Admin returns 500 on every route rather than serving unauthenticated |
| `DATABASE_URL` | Both refuse to start |

`ADMIN_SERVICE_TOKEN` must match between the API and the admin, and is what lets
the dashboard ask the API to issue a refund. It is not on its own sufficient:
the API also requires the acting administrator's id and verifies that person
really is an active administrator, so a leaked token cannot act as an arbitrary
user.

### Push

`PUSH_ENABLED=true` is what makes notifications leave the building. Without it
the API records every notification in the `notifications` table with a delivery
result and sends nothing — which is the right behaviour for a staging copy of
production data, and a silent disaster if it is what production is running. The
boot log says which mode it is in, and says so loudly in production.

`EXPO_ACCESS_TOKEN` is separate: Expo accepts unauthenticated sends until a
project turns on push security, at which point every send without the token
fails. Set it before you need it.

Dead tokens are pruned automatically. A phone that has been reinstalled answers
`DeviceNotRegistered`, usually in the receipt rather than the ticket, and the
`push.collect-receipts` sweep deletes the row. Transient errors — rate limits,
Expo outages — never delete anything, because silently unsubscribing a real user
is not recoverable from their side.

## The first administrator

The dashboard has no shared password and no bootstrap account. Make one:

```bash
docker run --rm -e DATABASE_URL=... grassassassin-api \
  node dist/admin-create.js --email you@example.com --password '...' --name 'Your Name'
```

It is bundled into the image alongside the server for exactly this reason: it
started life as a `tsx` script, which made the production answer to "how do you
get into the dashboard at all" into "have a checkout handy".

Idempotent — an existing account is granted the role rather than duplicated.
From a checkout, `pnpm --filter @grassassassin/api admin:create -- …` does the
same thing.

## Health and rollout

Both images declare a `HEALTHCHECK`. The API's `/health` verifies it is actually
serving, which "the container is running" does not. Point the orchestrator's
readiness probe at it and roll one instance at a time.

## Locally

```bash
docker compose up --build
```

PostGIS, Redis, migrations, the API on :4000 and the admin on :3001. The secrets
in `docker-compose.yml` are fake and visible on purpose; it is for development.

The images are production-shaped, so they do not carry `tsx` and cannot seed
themselves. Seed from a checkout against the exposed database:

```bash
DATABASE_URL=postgresql://grass:grass@localhost:5432/grassassassin \
  pnpm --filter @grassassassin/api db:seed
```

## Capacity, measured

`node scripts/load-test.mjs` hits a running API with real tokens: a burst of
PostGIS radius searches, then every eligible worker lunging at the same job at
once. It checks the ledger still nets to zero afterwards, and that the job ends
with exactly one claimant in the database — not just that the HTTP responses
looked right.

One container, one Postgres, both sharing a laptop-class CPU with everything
else in this repo, 400 searches per run:

| in flight | search p50 | search p95 | search p99 | claim p50 | claim p95 | winners |
| --------- | ---------- | ---------- | ---------- | --------- | --------- | ------- |
| 10        | 12ms       | 24ms       | 34ms       | 29ms      | 45ms      | 1       |
| 25        | 26ms       | 65ms       | 71ms       | 18ms      | 33ms      | 1       |
| 50        | 48ms       | 103ms      | 108ms      | 24ms      | 41ms      | 1       |
| 100       | 66ms       | 163ms      | 185ms      | 19ms      | 34ms      | 1       |
| 200       | 172ms      | 280ms      | 295ms      | 16ms      | 28ms      | 1       |

Search latency rises roughly in step with concurrency past 50, which is queueing
on a saturated box rather than the GIST index falling over — p99 tracks p95
closely the whole way, and a degenerate index shows up as a long tail, not a
uniform shift. The number worth watching in production is the gap between p95
and p99, not the absolute figures, which are a property of this machine.

The claim path does not degrade at all: it stays under 50ms at every level, and
exactly one worker wins every time.

Those figures predate a deliberate change: every authenticated request now
re-reads the account row, so that a ban, a suspension or a deletion takes effect
at once rather than lasting out the access token's fifteen minutes. That is one
primary-key lookup per authenticated request, and it is not free — a later run
on a busier machine measured search p95 at 143ms (25 concurrent) and 358ms
(100), against 65ms and 163ms before. The two runs are not a clean comparison,
because the second shared the box with more processes, but the direction is real
and the cause is understood.

The tempting optimisation is a short-lived cache of account state. It would
remove nearly all of those lookups and reintroduce, in miniature, exactly the
window that was just closed — a banned worker keeps working for the cache's TTL.
If it is ever added, the TTL is the security property and belongs in this
document, not buried in the code. That is the conditional
`UPDATE … WHERE status = 'POSTED'` doing its job — the losers are refused by the
database in one statement rather than queueing behind a lock.

What this does NOT tell you: it is a single API process against a single
Postgres on one machine, so it measures the code, not a cluster. It says nothing
about connection-pool exhaustion across replicas, about PgBouncer, or about what
happens when the ledger table is a hundred times larger. Re-run it against
staging before committing to instance sizing.

The suite refuses to report a green claim race it did not actually run: it
selects only workers who are approved, active and under their job cap, and only
a job whose deadline is still in the future — the same conditions the claim
itself enforces. An earlier version scavenged any POSTED job and reported
"0 winners" hours after seeding, when the real cause was that every seeded job
had expired. It also fails loudly if a claim comes back 429, because a run where
the rate limiter answered is a run that measured the limiter.

## What is not verified

The images have never been built. There is no container runtime in the
environment this was written in, so everything above is reasoned from what was
verified by hand, using a directory assembled to contain exactly what the image
will: the bundled server runs and serves the complete marketplace loop — post,
claim, message, photo upload, geofenced start, approve, pay, points, rate,
recurring — from nothing but `dist`, a pruned `node_modules` and `prisma`;
`dist/admin-create.js` really creates an administrator from that same tree;
`prisma migrate deploy` runs from it; and the admin's standalone output serves
and passes all 54 of its auth checks and 64 render combinations. The Dockerfiles assemble exactly those
pieces, but assembling them inside a real build has not happened. CI builds both
images so the first run will say.

The app has never run on a real handset. Every visual and accessibility check
in this repository runs against the React Native Web build, which is the same
components and the same layout engine but not the same runtime. What IS
verified is that Metro produces a clean iOS and a clean Android bundle — CI
builds both, so the class of break that only appears on a phone fails there
rather than in somebody's hand.

The EAS profiles in `apps/mobile/eas.json` have never been run: a build needs
an Expo account, and an iOS build needs an Apple Developer account. They are
written to the documented schema and are a starting point, not a pipeline
anyone has watched succeed.

No Terraform, no Kubernetes manifests, no CDN or WAF configuration. Object
storage for photos is behind a provider interface with a working fake; the R2
adapter is written but has never been pointed at a real bucket.
