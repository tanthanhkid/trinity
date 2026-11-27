#!/usr/bin/env bash
# Chạy bộ e2e MCP (run.mjs, run-roles.mjs, tuỳ chọn claude-code-roles.mjs) trên BINARY Rust (X04, PLAN mục 6.4).
# Dựng DB thử (migrate + seed + 3 tài khoản thử), bật `trinity serve` ở cổng riêng, chạy các kịch bản, tắt đúng tiến trình mình bật.
#
# Dùng:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/trinity_e2e \
#     tests/mcp-e2e/run-rust.sh [--with-model] [--runs N] [--bin <đường-dẫn-trinity>] [--port <cổng>] [--keep]
#
#   --with-model  (hoặc E2E_WITH_MODEL=1) thêm claude-code-roles.mjs (cần `claude` đã đăng nhập; tốn quota). Mặc định chỉ chạy phần tất định.
#   --runs N      với --with-model: chạy bộ nhiệm vụ N lần (mặc định 1; tham khảo PLAN 6.4 dùng 5).
#   --keep        không xoá thư mục tạm (credentials, log) khi xong.
#
# Tiêu chí cứng (X04): mọi bước của run.mjs và run-roles.mjs đạt; 0 lời gọi tool bị từ chối vì schema (đếm trong log
# của bước model). Tỉ lệ hoàn thành nhiệm vụ của model chỉ in ra để đối chiếu với Node, không chặn.
#
# KHÔNG chạy trên DB có dữ liệu thật: các kịch bản tạo/xoá dữ liệu. DB phải có tên chứa `test`, `e2e` hoặc `demo`
# (đặt E2E_ALLOW_ANY_DB=1 để bỏ kiểm này). Cổng mặc định 4300 (không đụng 3000/3100/4000/4100).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

with_model="${E2E_WITH_MODEL:-0}"; runs=1; keep=0; port="${E2E_PORT:-4300}"
bin="${TRINITY_BIN:-${CARGO_TARGET_DIR:-$HOME/.cache/trinity/target}/release/trinity}"
while [ $# -gt 0 ]; do
  case "$1" in
    --with-model) with_model=1 ;;
    --runs) runs="${2:?thiếu số lần}"; shift ;;
    --bin) bin="${2:?thiếu đường dẫn binary}"; shift ;;
    --port) port="${2:?thiếu cổng}"; shift ;;
    --keep) keep=1 ;;
    -h|--help) sed -n 2,19p "$0"; exit 0 ;;
    *) echo "đối số lạ: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$runs" in ''|*[!0-9]*|0) echo "--runs phải là số nguyên dương" >&2; exit 2 ;; esac

: "${DATABASE_URL:?cần DATABASE_URL trỏ vào DB thử (Postgres trống)}"
db_name="${DATABASE_URL##*/}"; db_name="${db_name%%\?*}"
if [ "${E2E_ALLOW_ANY_DB:-0}" != 1 ]; then
  case "$db_name" in
    *test*|*e2e*|*demo*) ;;
    *) echo "DB '$db_name' không có chữ test/e2e/demo: từ chối (đặt E2E_ALLOW_ANY_DB=1 nếu chắc đây là DB thử)" >&2; exit 2 ;;
  esac
fi

[ -x "$bin" ] || { echo "không thấy binary chạy được: $bin (build: cd server && scripts/cargo-q build -p trinity-bin --release)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "thiếu node" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "thiếu curl" >&2; exit 1; }
[ -d "$root/node_modules/@modelcontextprotocol" ] || { echo "thiếu SDK MCP: pnpm install ở thư mục gốc repo" >&2; exit 1; }
if [ "$with_model" = 1 ]; then command -v claude >/dev/null 2>&1 || { echo "--with-model cần lệnh claude" >&2; exit 1; }; fi

# Cổng phải trống: chỉ bật server của mình, không kill tiến trình lạ.
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/v1/health"; then
  echo "cổng $port đã có dịch vụ trả lời; đổi --port" >&2; exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/mcp-e2e-rust.XXXXXX")"
logs="$work/logs"; mkdir -p "$logs"
cred="$work/credentials.env"
srv_pid=""
cleanup() {
  rc=$?
  if [ -n "$srv_pid" ] && kill -0 "$srv_pid" 2>/dev/null; then
    kill "$srv_pid" 2>/dev/null || true
    for _ in $(seq 20); do kill -0 "$srv_pid" 2>/dev/null || break; sleep 0.5; done
  fi
  if [ "$keep" = 1 ] || [ $rc -ne 0 ]; then echo "giữ lại $work (credentials có mật khẩu thử, log trong logs/)" >&2
  else rm -rf "$work"; fi
  exit $rc
}
trap cleanup EXIT INT TERM

rand() { if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48; fi; }
export NODE_ENV=development
export JWT_SECRET="${JWT_SECRET:-$(rand)}"
export INTERNAL_SERVICE_SECRET="${INTERNAL_SERVICE_SECRET:-$(rand)}"
export TRINITY_HTTP_PORT="$port"
export CORS_ORIGIN="http://127.0.0.1:$port"
export SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@example.com}"
export SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-Admin@12345}"
export SAMPLE_PASSWORD="${SAMPLE_PASSWORD:-Demo@12345}"
export MCP_BASE="http://127.0.0.1:$port"
export DEMO_DATABASE_URL="$DATABASE_URL"
export MCP_LOG_DIR="$logs"
export E2E_ALLOW_LOCAL_DB=1
export E2E_RUST=1
# OAuth + MCP chỉ bật khi có 3 biến này (giá trị thử tự sinh, không dùng khoá thật).
export INTEGRATIONS_MCP_ENABLED=true
export INTEGRATIONS_PUBLIC_BASE_URL="http://127.0.0.1:$port"
export INTEGRATIONS_SECRET_KEY="${INTEGRATIONS_SECRET_KEY:-$(rand)}"

step() { printf '\n=== %s\n' "$*"; }

step "Binary: $bin"
"$bin" check-config
step "Migrate + seed mẫu"
"$bin" migrate
"$bin" seed --sample

step "Tài khoản thử (admin, chỉ xem, các vai trò)"
node "$here/setup-users.mjs" "$cred"
node "$here/setup-users-roles.mjs" "$cred"
# Credentials ghi sẵn cổng 4000; MCP_BASE trong môi trường thắng (lib.mjs, run.mjs đọc env trước file).

step "Bật trinity serve (cổng $port)"
"$bin" serve >"$logs/serve.log" 2>&1 &
srv_pid=$!
ok=0
for _ in $(seq 60); do
  kill -0 "$srv_pid" 2>/dev/null || { echo "serve chết sớm:" >&2; tail -n 30 "$logs/serve.log" >&2; exit 1; }
  if curl -fs -o /dev/null --max-time 2 "$MCP_BASE/api/v1/health"; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "serve không lên sau 60 giây:" >&2; tail -n 30 "$logs/serve.log" >&2; exit 1; }

node "$here/setup-fixture.mjs" "$cred"

fail=0
run() { # run <tên> <lệnh...>: ghi log, không dừng khi một kịch bản đỏ để còn thấy hết
  local name="$1"; shift
  step "$name"
  if "$@" 2>&1 | tee "$logs/$name.log"; then :; else fail=1; fi
  # pipefail: trạng thái của lệnh đầu pipeline
}
run run node "$here/run.mjs" "$cred"
run run-roles node "$here/run-roles.mjs" "$cred"
# smoke OAuth + MCP bằng curl thuần (không SDK): cùng server, tài khoản admin thử.
admin_email="$(sed -n 's/^MCP_ADMIN_EMAIL=//p' "$cred")"; admin_pw="$(sed -n 's/^MCP_ADMIN_PASSWORD=//p' "$cred")"
run smoke-mcp env EXPECT_TOTAL="$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d if isinstance(d,list) else d["tools"]))' "$root/server/contracts/mcp/tools.json")" \
  bash "$root/server/scripts/smoke-mcp.sh" "$MCP_BASE" "$admin_email" "$admin_pw"
# Cuối cùng vì quét 110 tool chạm trần 60 lời gọi/phút của admin (có chờ).
run tools-sweep node "$here/tools-sweep.mjs" "$cred"

if [ "$with_model" != 1 ]; then
  step "SKIP  claude-code-roles.mjs (bộ nhiệm vụ bằng model)"
  echo "SKIP  chưa chạy: cần \`claude\` đăng nhập (khoá/quota AI) — bật lại bằng --with-model hoặc E2E_WITH_MODEL=1 (X04, #262)"
else
  for i in $(seq "$runs"); do
    mkdir -p "$logs/model-$i"
    run "claude-code-roles-$i" env MCP_LOG_DIR="$logs/model-$i" node "$here/claude-code-roles.mjs" "$cred" "$logs/model-$i"
  done
  # Tiêu chí cứng: 0 lời gọi bị từ chối vì schema (mã JSON-RPC -32602 / thông điệp kiểm đầu vào của SDK).
  step "Đếm lời gọi tool bị từ chối vì schema"
  schema_rej=$(grep -rEil -- '-32602|invalid arguments|input validation error|invalid_type|"code":"invalid' "$logs"/model-*/ 2>/dev/null | wc -l | tr -d ' ')
  hits=$(grep -rEic -- '-32602|invalid arguments|input validation error' "$logs"/model-*/ 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')
  echo "tệp log có dấu hiệu schema bị từ chối: $schema_rej; số dòng khớp: $hits"
  if [ "$hits" -gt 0 ]; then
    echo "FAIL  có lời gọi tool bị từ chối vì schema" >&2
    grep -rEn -- '-32602|invalid arguments|input validation error' "$logs"/model-*/ | head -20 >&2 || true
    fail=1
  else
    echo "PASS  0 lời gọi bị từ chối vì schema"
  fi
  # Số tham khảo: số lượt claude thoát 0 / tổng, để đối chiếu với Node (không chặn).
  total=$(grep -hc '^## ' "$logs"/model-*/claude-code-*.log 2>/dev/null | awk '{s+=$1} END{print s+0}')
  okc=$(grep -h 'exit=0' "$logs"/model-*/claude-code-*.log 2>/dev/null | wc -l | tr -d ' ')
  echo "Tham khảo (không chặn): $okc/$total lượt nhiệm vụ claude thoát 0 qua $runs lần chạy"
fi

step "Kết quả"
if [ "$fail" = 0 ]; then echo "PASS  e2e MCP trên binary Rust"; else echo "FAIL  xem log trong $logs (giữ lại)" >&2; fi
exit "$fail"
