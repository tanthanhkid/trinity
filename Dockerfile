# syntax=docker/dockerfile:1.7
#
# Multi-target image for Trinity. Targets:
#   api    — NestJS monolith and the migrate/seed job (same image, different command)
#   trinity — binary Rust: phục vụ web tĩnh (out/, WEB_DIR=/srv/web) và chuyển phần chưa viết sang api (W02b: không còn Next server)
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
RUN pnpm --filter "./packages/*" --if-present build \
 && pnpm --filter @trinity/monolith build
# The browser-side API base URL is inlined by Next at build time.
ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# Web tĩnh: `next build` xuất thẳng ra apps/web/out (output: export, W02b).
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
# rust-build / trinity: binary Rust + web tĩnh (cổng công khai của compose, W02b).
# Dựng từ nguồn trên máy người vận hành; bản chạy bằng trình quản lý tiến trình tải binary từ artifact CI thay vì dựng ở đây.
#   docker build --target trinity -t trinity-rust .
# ---------------------------------------------------------------------------
FROM rust:1.100.0-slim-bookworm AS rust-build
ENV SQLX_OFFLINE=true CARGO_TERM_COLOR=never
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Bộ migration nhúng lúc biên dịch đọc nguyên văn server/prisma/migrations (trinity-db/src/migrate.rs), nằm sẵn trong `server/`.
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
# Web tĩnh từ stage `build`; `WEB_DIR` trỏ ra thư mục ngoài nên vá web không cần dựng lại binary (K18).
COPY --from=build /app/apps/web/out /srv/web
ENV NODE_ENV=production TRINITY_HTTP_PORT=3000 WEB_DIR=/srv/web
USER trinity
EXPOSE 3000
CMD ["trinity", "serve"]
