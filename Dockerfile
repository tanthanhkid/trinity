# syntax=docker/dockerfile:1.7
#
# Multi-target image for Trinity. Targets:
#   api    — NestJS monolith and the migrate/seed job (same image, different command)
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
# api: monolith + migrate/seed job.
# ---------------------------------------------------------------------------
FROM build AS api
ENV NODE_ENV=production PORT=4000
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
# Tệp nạp trước: web là tiến trình biên — xác định IP khách theo TRUSTED_PROXY và ký x-trinity-client-ip cho API
# (docs/deployment.md, mục "Client IP"). Thiếu tệp này thì API coi IP mọi khách là "không tin được".
COPY --from=build /app/apps/web/peer-ip.cjs ./apps/web/peer-ip.cjs
ENV NODE_OPTIONS="--require /app/apps/web/peer-ip.cjs"
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# rust-build / trinity: binary Rust (chỉ dùng cho cấu hình lai, docs/runbooks/hybrid.md; không nằm trong compose mặc định).
# Dựng từ nguồn trên máy người vận hành; bản chạy bằng trình quản lý tiến trình tải binary từ artifact CI thay vì dựng ở đây.
#   docker build --target trinity -t trinity-rust .
# ---------------------------------------------------------------------------
FROM rust:1.100.0-slim-bookworm AS rust-build
ENV SQLX_OFFLINE=true CARGO_TERM_COLOR=never
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Bộ migration nhúng lúc biên dịch đọc nguyên văn packages/prisma/prisma/migrations (trinity-db/src/migrate.rs).
COPY packages/prisma/prisma ./packages/prisma/prisma
COPY server ./server
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target,target=/src/server/target \
    cd server \
 && cargo build --release --locked -p trinity-bin \
 && cp target/release/trinity /usr/local/bin/trinity

FROM debian:bookworm-slim AS trinity
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home trinity
COPY --from=rust-build /usr/local/bin/trinity /usr/local/bin/trinity
ENV NODE_ENV=production TRINITY_HTTP_PORT=3000
USER trinity
EXPOSE 3000
CMD ["trinity", "serve"]
