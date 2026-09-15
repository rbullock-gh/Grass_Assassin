# syntax=docker/dockerfile:1

# The admin dashboard, as Next's standalone output.
#
# Standalone traces the files the server actually reaches and writes a
# self-contained tree, so the image carries neither the monorepo nor a full
# node_modules. The two things this gets wrong if you are not careful: the
# static assets are NOT traced and have to be copied in by hand, and the trace
# root has to be the workspace root or the hoisted dependencies are left behind.
# Both are handled below and in next.config.mjs.

FROM node:22-bookworm-slim AS deps
WORKDIR /repo

RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/design/package.json packages/design/
COPY packages/client/package.json packages/client/

RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --filter @grassassassin/admin...

FROM deps AS build
WORKDIR /repo

COPY packages/ packages/
COPY apps/admin/ apps/admin/
# The admin reads the marketplace database with the same Prisma client, so it
# needs the schema to generate against.
COPY apps/api/prisma/ apps/api/prisma/

# A build-time value only. The real one is supplied at run time; this exists so
# `next build` can construct a Prisma client without a live database.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
# Without a secret the dashboard runs unauthenticated, which it refuses to do
# in production — and this IS a production build. A throwaway value keeps the
# build honest without baking a real one into a layer.
ENV ADMIN_SESSION_SECRET="build-time-placeholder-not-a-real-secret-x"

RUN pnpm --filter @grassassassin/api db:generate && \
    pnpm --filter @grassassassin/admin build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
# Next's standalone server binds to localhost by default, which inside a
# container means nothing outside it can connect.
ENV HOSTNAME=0.0.0.0

RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --uid 10001 grass

COPY --from=build --chown=grass:grass /repo/apps/admin/.next/standalone ./
# Not traced by standalone. Without this the pages render unstyled, which is
# easy to miss because they do still render.
COPY --from=build --chown=grass:grass /repo/apps/admin/.next/static ./apps/admin/.next/static

USER grass
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/sign-in').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/admin/server.js"]
