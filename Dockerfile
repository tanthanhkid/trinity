# syntax=docker/dockerfile:1.7
#
# Image duy nhất của Trinity (X06): binary Rust `trinity` + web tĩnh. Không còn Node ở lúc chạy.
#   web-build  — dựng web tĩnh (Next `output: export`) bằng Node; chỉ nằm trong stage dựng, không vào image chạy
#   rust-build — biên dịch binary `trinity` (bộ migration nhúng lúc biên dịch từ server/prisma/migrations)
#   trinity    — image chạy (stage cuối, mặc định của `docker build .`)
#
#   docker build -t trinity .
#
# docker-compose.yml nối mọi thứ lại; thường không cần gọi trực tiếp.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# web-build: chỉ cài và dựng những gì apps/web cần (gói workspace mà web phụ thuộc), kết quả ở apps/web/out.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS web-build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.6.5
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "web..."
# Gói workspace mà web import (không gồm chính web), rồi web tĩnh: `next build` xuất ra apps/web/out.
RUN pnpm --filter "web^..." --if-present build
# URL API phía trình duyệt được Next nhúng lúc build.
ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm --filter web build

# ---------------------------------------------------------------------------
# rust-build: binary Rust. Dựng từ nguồn trên máy người vận hành; bản chạy bằng trình quản lý tiến trình tải binary từ
# artifact CI thay vì dựng ở đây.
# ---------------------------------------------------------------------------
FROM rust:1.100.0-slim-bookworm AS rust-build
ENV SQLX_OFFLINE=true CARGO_TERM_COLOR=never
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Bộ migration nhúng lúc biên dịch đọc nguyên văn server/prisma/migrations (trinity-db/build.rs) nên nằm trong COPY server.
COPY server ./server
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cargo-target,target=/src/server/target \
    cd server \
 && cargo build --release --locked -p trinity-bin \
 && cp target/release/trinity /usr/local/bin/trinity

# ---------------------------------------------------------------------------
# trinity: image chạy. Tương thích bản cài cũ: uid 1000 (volume cũ do user `node` uid 1000 sở hữu), giữ
# /app/uploads và /var/lib/trinity/storage, cổng 3000.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS trinity
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home trinity \
 && mkdir -p /var/lib/trinity/storage /app/uploads \
 && chown -R 1000:1000 /var/lib/trinity /app/uploads
COPY --from=rust-build /usr/local/bin/trinity /usr/local/bin/trinity
# Web tĩnh; `WEB_DIR` trỏ ra thư mục ngoài nên vá web không cần dựng lại binary (K18).
COPY --from=web-build /app/apps/web/out /srv/web
ENV NODE_ENV=production TRINITY_HTTP_PORT=3000 WEB_DIR=/srv/web STORAGE_LOCAL_ROOT=/var/lib/trinity/storage
USER trinity
EXPOSE 3000
CMD ["trinity", "serve"]
