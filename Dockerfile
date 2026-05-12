################################################################################
# Flagship — flagship.services on Fly.
#
# Stage 1: install workspace deps + tsc -b → packages/*/dist + apps/web/dist
# Stage 2: copy only what's needed at runtime: node_modules + dist + public
#
# Runs the apps/web Fastify server in surface=services mode by default;
# override FLAGSHIP_SURFACE to "com" or "both" for other shapes.
################################################################################

FROM node:20-alpine AS builder
WORKDIR /app

# Workspaces: copy package.json files only first, install with cache-friendly
# layer, then copy source. (npm doesn't cache layers as cleanly as pnpm; this
# is good-enough for a small monorepo.)
COPY package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages packages/
# scripts/pull-maintainers.sh + its pinned-SHA file are needed BEFORE the
# preinstall hook on `npm install`. The pull-maintainers script needs git
# at runtime; the rest of the build is plain Node.
COPY scripts/pull-maintainers.sh scripts/maintainers.pinned-sha scripts/
RUN apk add --no-cache git bash
# Pull the maintainers tree from ibisllc/maintainers at the pinned SHA
# (docs/maintainers-deployment.md). It's gitignored locally; the
# Dockerfile is the canonical place this fetches in CI.
RUN bash scripts/pull-maintainers.sh
# services/marketplace-scanner is referenced from root tsconfig.json so
# `tsc -b` walks into it. Same story as maintainers/ — needed only at
# build time, not runtime.
COPY services services/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY apps/web/src apps/web/src/
COPY apps/web/public apps/web/public/
COPY apps/com/package.json apps/com/

# The npm preinstall hook re-runs pull-maintainers; SKIP_PULL_MAINTAINERS=1
# tells it to no-op since we just pulled. Saves a network round-trip.
# /bin/sh in alpine is busybox sh, which doesn't grok subshell parens — chain
# with ||/&& and repeat the env var to avoid the grouping.
RUN --mount=type=cache,target=/root/.npm \
    SKIP_PULL_MAINTAINERS=1 npm ci --workspaces --include-workspace-root --no-audit --no-fund --ignore-scripts \
 || SKIP_PULL_MAINTAINERS=1 npm install --workspaces --include-workspace-root --no-audit --no-fund

RUN npx tsc -b

################################################################################

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# `both` because the Cloudflare Worker fronts /api/* and proxies everything
# to this app — including .com-surface routes (username registry, auth code
# issuance). When .services moves to its own host, switch to `services`.
ENV FLAGSHIP_SURFACE=both
ENV TUNNEL_TCP_PORT=8443

# Need only the slimmed runtime tree.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/web ./apps/web
COPY --from=builder /app/apps/com/package.json ./apps/com/package.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 3000
EXPOSE 8443

# Run via tsx so cross-workspace `@flagship/*` imports resolve to TS source
# (workspace package.json files point `main` at ./src/index.ts; switching
# them all to dist/ for prod is a follow-up).
CMD ["npx", "--yes", "tsx", "apps/web/src/server.ts"]
