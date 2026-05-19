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
# The maintainers protocol is the published npm package
# `@ibisllc/maintainers` (exact pin in packages/server-daemon/package.json).
# It is fetched from the registry by `npm ci`/`npm install` below — no
# git clone or build-time pull step.
# services/marketplace-scanner is referenced from root tsconfig.json so
# `tsc -b` walks into it. Needed only at build time, not runtime.
COPY services services/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY apps/web/src apps/web/src/
COPY apps/web/public apps/web/public/
COPY apps/com/package.json apps/com/

# Plain workspace install — `@ibisllc/maintainers` resolves from the npm
# registry like any other dependency (no lifecycle pull/bundle hooks).
# Fallback to `npm install` if `npm ci` fails (e.g. lockfile drift).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root --no-audit --no-fund \
 || npm install --workspaces --include-workspace-root --no-audit --no-fund

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
