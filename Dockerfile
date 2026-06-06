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
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY apps/web/src apps/web/src/
COPY apps/web/public apps/web/public/
COPY apps/com/package.json apps/com/
COPY tools tools/

# Install ALL deps (incl. dev) so tsc + types are available for the
# `tsc -b` step. devDependencies are pruned out below before the runtime
# stage copies node_modules.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root --no-audit --no-fund \
 || npm install --workspaces --include-workspace-root --no-audit --no-fund

RUN npx tsc -b

# Slim the runtime image:
#   1. Drop per-workspace node_modules for workspaces the Fly runtime
#      never touches (the other Cloudflare Workers + the e2e harness).
#      Most deps are hoisted to the root anyway; this is belt-and-braces
#      for any non-hoisted ones (~tens of MB).
#   2. `npm prune --omit=dev` removes typescript, tsx, vitest, @types/*,
#      and other build-only tools from the root node_modules (~150-200 MB).
#   3. Strip src/ + tests/ from every workspace — runtime needs only
#      dist/ (compiled JS) + package.json + apps/web/public (static
#      assets). Saves another ~80-150 MB depending on per-package source
#      footprint.
RUN rm -rf apps/com/node_modules apps/boot/node_modules \
           apps/dns-broker/node_modules apps/web/e2e/node_modules \
           2>/dev/null || true
RUN npm prune --omit=dev
RUN find packages -type d \( -name src -o -name tests \) -prune -exec rm -rf {} + \
 && find apps/web -type d \( -name src -o -name tests -o -name e2e \) -prune -exec rm -rf {} +

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

EXPOSE 3000
EXPOSE 8443

# Workspace package.json files point `main` at ./dist/index.js — runtime
# resolves to compiled JS via plain `node`, no tsx transformer needed.
CMD ["node", "apps/web/dist/server.js"]
