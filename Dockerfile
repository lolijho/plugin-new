# syntax=docker/dockerfile:1

# ── deps: install all dependencies (including dev, needed for the build) ──────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── build: compile the Next.js app (standalone output) ───────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholders so module-load checks pass during build; real values come from
# the runtime environment (Coolify env vars), never from the image.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV AUTH_SECRET="build-time-placeholder-secret-change-me"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── runtime: minimal image with PHP CLI for `php -l` syntax validation ────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends php-cli \
  && rm -rf /var/lib/apt/lists/*

# Next.js standalone server + assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Migrations + runner. Overlay the full (zero-dependency) packages the migrate
# script needs so it never depends on standalone tree-shaking.
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps /app/node_modules/postgres ./node_modules/postgres

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
