# syntax=docker/dockerfile:1.7
#
# Multi-target image for Trinity. Targets:
#   api    — NestJS monolith (also contains Deno for sandboxed add-ons) and the
#            migrate/seed job (same image, different command)
#   web    — Next.js standalone server
#
#   docker build --target api -t trinity-api .
#
# docker-compose.yml wires everything together; you normally do not call this directly.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# build: install the whole workspace and compile everything
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.6.5
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Prisma clients (the schema URL is only needed at runtime, a dummy value is enough here).
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm --filter @trinity/prisma generate \
 && pnpm --filter "./packages/*" build \
 && pnpm --filter @trinity/monolith build
# The browser-side API base URL is inlined by Next at build time.
ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# Next bakes rewrites in at build time: the OAuth/MCP discovery URLs under /.well-known/*
# are forwarded to this address, so it must be the API as seen from the web container.
ARG MONOLITH_INTERNAL_URL=http://api:4000
ENV MONOLITH_INTERNAL_URL=${MONOLITH_INTERNAL_URL}
RUN pnpm --filter web build

# ---------------------------------------------------------------------------
# api: monolith + migrate/seed job. Deno is installed for the add-on runner.
# ---------------------------------------------------------------------------
FROM denoland/deno:bin-2.1.4 AS deno-bin

FROM build AS api
ENV NODE_ENV=production PORT=4000
COPY --from=deno-bin /deno /usr/local/bin/deno
RUN mkdir -p /var/lib/trinity/storage /app/uploads \
 && chown -R node:node /var/lib/trinity /app/uploads
USER node
EXPOSE 4000
CMD ["node", "apps/monolith/dist/apps/monolith/src/main.js"]

# ---------------------------------------------------------------------------
# web: Next.js standalone output
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
