# syntax=docker/dockerfile:1

# Build the API into a single bundled file, then ship that with only the
# dependencies it genuinely needs at runtime.
#
# The bundling is not an optimisation. The workspace packages ship TypeScript
# source — @grassassassin/shared's entry point is src/index.ts — so a plain tsc
# output imports files Node cannot load and the server dies on its first
# import. Inlining the workspace packages removes cross-package resolution from
# the runtime entirely. See apps/api/build.mjs.

# ---------------------------------------------------------------------------
# deps — install once, cached until the lockfile changes
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /repo

RUN corepack enable

# Only the manifests, so editing source does not invalidate the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/design/package.json packages/design/
COPY packages/client/package.json packages/client/

RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --filter @grassassassin/api...

# ---------------------------------------------------------------------------
# build — generate the Prisma client and bundle the server
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY packages/ packages/
COPY apps/api/ apps/api/

RUN pnpm --filter @grassassassin/api db:generate && \
    pnpm --filter @grassassassin/api build

# Production dependencies only, for the runtime stage. The bundle inlines the
# workspace packages but leaves registry dependencies external — bundling
# argon2 or the Prisma engines would break them, and patching a CVE in a
# bundled dependency means a rebuild rather than an install.
#
# `--legacy` produces a flat node_modules rather than pnpm's symlink farm,
# which is what makes it copyable into a different path in another stage.
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm --filter @grassassassin/api deploy --prod --legacy /runtime

# The pruned tree has @prisma/client but NOT the generated client, and cannot
# generate it for itself — the Prisma CLI is a dev dependency and has just been
# pruned away. So it is copied in from where the generator actually wrote it.
RUN node apps/api/scripts/stage-prisma-client.mjs /runtime/node_modules

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# openssl is needed by the Prisma query engine; the slim image omits it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Never root. A remote code execution in a dependency should not also be a
# container with permission to rewrite itself.
RUN useradd --system --create-home --uid 10001 grass

COPY --from=build --chown=grass:grass /runtime/node_modules ./node_modules
COPY --from=build --chown=grass:grass /repo/apps/api/dist ./dist
# Migrations travel with the image so a deploy can apply them, rather than
# depending on somebody running the right command from the right checkout.
COPY --from=build --chown=grass:grass /repo/apps/api/prisma ./prisma

USER grass
EXPOSE 4000

# Checked by the orchestrator rather than assumed. /health verifies the process
# is actually serving, which "the container is running" does not.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
