#!/usr/bin/env bash
# W04: chạy Playwright (smoke, rbac-ui, rbac-api, static-web) trên web tĩnh do binary Rust `trinity serve` phục vụ.
# Một lệnh: dựng web tĩnh (nếu thiếu `out/`), dựng binary (bản debug, qua cargo-q), tạo DB tạm + migrate + seed --sample,
# để Playwright (E2E_SERVER=rust) tự khởi động binary, rồi xoá DB tạm.
#
#   server/scripts/e2e-rust.sh [project ...]      mặc định: smoke rbac-ui rbac-api static-web
#
# Biến: E2E_WORKERS (mặc định 2), E2E_RUST_PORT (3300), E2E_PG_URL (kết nối quản trị Postgres, mặc định
# postgres://localhost:5432/postgres), E2E_REBUILD_WEB=1 (dựng lại out/), E2E_RUST_BIN (dùng binary
# có sẵn, bỏ bước build), E2E_BROWSER_CHANNEL (vd chrome). Cấu hình Node cũ: bỏ E2E_SERVER=rust, chạy `pnpm e2e` như trước.
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$SERVER_DIR/../apps/web"
ROOT="$SERVER_DIR/.."
PG_URL="${E2E_PG_URL:-postgres://localhost:5432/postgres}"
PORT="${E2E_RUST_PORT:-3300}"
DB_NAME="trinity_e2e_$$"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trinity-e2e.XXXXXX")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/trinity/target}"
export PATH="$HOME/.cargo/bin:$PATH"

projects=("$@"); [ ${#projects[@]} -gt 0 ] || projects=(smoke rbac-ui rbac-api static-web)

cleanup() {
  psql "$PG_URL" -qc "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

# 1. Web tĩnh.
if [ -n "${E2E_REBUILD_WEB:-}" ] || [ ! -f "$WEB_DIR/out/index.html" ]; then
  echo "== dựng web tĩnh"
  (cd "$ROOT" && pnpm --filter @trinity/rbac --filter @trinity/utils --filter @trinity/storage --filter @trinity/logger build)
  (cd "$WEB_DIR" && pnpm build:export)
fi

# 2. Binary (chép ra chỗ riêng để build khác không đè khi đang chạy).
if [ -z "${E2E_RUST_BIN:-}" ]; then
  echo "== dựng binary"
  (cd "$SERVER_DIR" && scripts/cargo-q build -p trinity-bin)
  cp "$CARGO_TARGET_DIR/debug/trinity" "$RUN_DIR/trinity"
  E2E_RUST_BIN="$RUN_DIR/trinity"
fi
export E2E_RUST_BIN

# 3. DB tạm + seed.
psql "$PG_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$DB_NAME\""
export DATABASE_URL="${PG_URL%/*}/$DB_NAME"
export NODE_ENV=development
export TRINITY_HTTP_PORT="$PORT"
export CORS_ORIGIN="http://127.0.0.1:$PORT"
export SEED_ADMIN_EMAIL="admin@example.com" SEED_ADMIN_PASSWORD="Admin@12345" SAMPLE_PASSWORD="Demo@12345"
# Bật MCP/AI actions và webhook (tắt thì các route /integrations/* trả 404 như bản Node).
export INTEGRATIONS_WEBHOOKS_ENABLED=true INTEGRATIONS_SECRET_KEY="$(openssl rand -base64 32)" INTEGRATIONS_MCP_ENABLED=true INTEGRATIONS_PUBLIC_BASE_URL="http://127.0.0.1:$PORT"
export JWT_SECRET="$(openssl rand -hex 32)" INTERNAL_SERVICE_SECRET="$(openssl rand -hex 32)"
"$E2E_RUST_BIN" migrate >/dev/null
"$E2E_RUST_BIN" seed --sample >/dev/null

# 3b. Thêm tài khoản Nhân sự + Trưởng phòng (seed chỉ có admin/lead/sale): bật binary tạm, tạo qua API, dừng đúng PID.
"$E2E_RUST_BIN" serve >"$RUN_DIR/provision.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 1; done
node "$SERVER_DIR/scripts/e2e-provision.mjs" "http://127.0.0.1:$PORT" "$SEED_ADMIN_EMAIL" "$SEED_ADMIN_PASSWORD" "$SAMPLE_PASSWORD" \
  || { kill "$SRV_PID" 2>/dev/null; cat "$RUN_DIR/provision.log" | tail -20; exit 1; }
kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null || true

# 4. Playwright. Tài khoản = dữ liệu seed tạm ở trên (xoá cùng DB).
export E2E_SERVER=rust E2E_RUST_PORT="$PORT"
export E2E_ADMIN_EMAIL="$SEED_ADMIN_EMAIL" E2E_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD"
export E2E_LEAD_EMAIL="truongnhom@demo.local" E2E_LEAD_PASSWORD="$SAMPLE_PASSWORD"
export E2E_SALE_EMAIL="sale1@demo.local" E2E_SALE_PASSWORD="$SAMPLE_PASSWORD"
export E2E_HR_EMAIL="nhansu@demo.local" E2E_HR_PASSWORD="$SAMPLE_PASSWORD"
export E2E_DEPT_HEAD_EMAIL="truongphong@demo.local" E2E_DEPT_HEAD_PASSWORD="$SAMPLE_PASSWORD"
export E2E_WORKERS="${E2E_WORKERS:-2}"
args=(); for p in "${projects[@]}"; do args+=("--project=$p"); done
cd "$WEB_DIR"
npx playwright test "${args[@]}"
