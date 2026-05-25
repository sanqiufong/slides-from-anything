FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat tar
# We ship only apps/community/ to the VPS, not the whole workspace, so the
# lockfile lives upstream. `pnpm install` (no --frozen-lockfile) resolves
# fresh from package.json. Versions in package.json are pinned, so drift risk
# is small. If we ever ship the full workspace, switch back to frozen.
COPY package.json ./
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate \
  && pnpm install --prod=false

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat tar
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time placeholder env so `env.ts`'s required() assertions pass during
# Next's page-data collection. None of these values ever ship; the runtime
# container is launched with real values from .env via docker compose.
RUN corepack enable \
  && corepack prepare pnpm@10.33.2 --activate \
  && DATABASE_URL='postgres://build:build@build/build' \
     PUBLIC_BASE_URL='https://build.invalid' \
     BUNDLE_STORAGE_ROOT='/tmp/build' \
     GITHUB_CLIENT_ID='build' \
     GITHUB_CLIENT_SECRET='build' \
     ADMIN_GITHUB_LOGINS='build' \
     SESSION_SECRET='build-only-session-secret-placeholder' \
     pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache tar tini \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
ENV NODE_ENV=production
# Pre-create the bundle storage dir as nextjs-owned. When docker mounts a
# named volume to a directory that already exists in the image, it copies the
# image dir's ownership into the new volume — so first-time deployments come
# up writable without a separate chown step.
RUN mkdir -p /var/lib/design-vault/bundles \
  && chown -R nextjs:nodejs /var/lib/design-vault
# No public/ dir in this app; skip its copy.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
