#!/usr/bin/env bash
# Chạy backend Rust trên localhost với DB trống + dữ liệu mẫu (Linux/WSL/macOS).
# Dùng: server/scripts/localhost.sh [--no-serve]
set -euo pipefail

cd "$(dirname "$0")/.."   # thư mục server/

# Nạp cấu hình tuỳ chọn.
if [ -f scripts/localhost.env ]; then
  set -a; . scripts/localhost.env; set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/trinity}"
export NODE_ENV="${NODE_ENV:-development}"
export TRINITY_HTTP_PORT="${TRINITY_HTTP_PORT:-3000}"
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:3000}"
export SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@example.com}"
export SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-Admin@12345}"
export SAMPLE_PASSWORD="${SAMPLE_PASSWORD:-Demo@12345}"

rand_secret() { # >= 32 ký tự
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48; fi
}
export JWT_SECRET="${JWT_SECRET:-$(rand_secret)}"
export INTERNAL_SERVICE_SECRET="${INTERNAL_SERVICE_SECRET:-$(rand_secret)}"

command -v cargo >/dev/null 2>&1 || { echo "Thiếu cargo (cài Rust theo server/rust-toolchain.toml)" >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "Thiếu psql (cài postgresql-client)" >&2; exit 1; }

# Tách tên DB khỏi URL; kết nối vào DB 'postgres' để tạo nếu thiếu.
DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
ADMIN_URL="${DATABASE_URL%/*}/postgres"
if ! psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1; then
  echo "Tạo database '$DB_NAME'..."
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\""
fi

cargo run -p trinity-bin -- check-config
cargo run -p trinity-bin -- migrate
cargo run -p trinity-bin -- seed --sample

cat <<MSG

==================================================================
 Địa chỉ:  http://localhost:${TRINITY_HTTP_PORT}
 Quản trị:    ${SEED_ADMIN_EMAIL} / (mật khẩu: SEED_ADMIN_PASSWORD, mặc định Admin@12345; chỉ áp dụng khi tài khoản mới tạo)
 Trưởng nhóm: truongnhom@demo.local / ${SAMPLE_PASSWORD}
 Sale:        sale1@demo.local, sale2@demo.local / ${SAMPLE_PASSWORD}
==================================================================
MSG

if [ "${1:-}" = "--no-serve" ]; then exit 0; fi
exec cargo run -p trinity-bin -- serve
