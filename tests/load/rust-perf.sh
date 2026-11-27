#!/usr/bin/env bash
# X05: đo RAM / CPU / kết nối Postgres / khởi động / ca tải của bản Rust, trên LINUX 2 GB hoặc 1 GB (PLAN mục 9).
# KHÔNG chạy trên Mac dev 16 GB để lấy số chính thức (chỉ để thử script). Một lệnh:
#
#   TRINITY_BIN=./trinity DATABASE_URL=postgres://u:p@127.0.0.1:5432/db_rieng EMAIL=... PASSWORD=... \
#     PROFILE=2gb tests/load/rust-perf.sh <nhãn-bộ-cấp-phát>
#
# Env: PROFILE=2gb|1gb (1gb: pool 4, 1 worker, MemoryMax=900M; 2gb: MemoryMax=1500M), TRINITY_HTTP_PORT (mặc định 4310),
#      STUB_PORT (9911), DURATION_S (30). DB RIÊNG đã migrate + seed; script ghi thêm vào DB (upload/xuất).
# Chạy 2 lần, mỗi lần một binary build với bộ cấp phát khác (hệ thống và mimalloc), nhãn `system` và `mimalloc`;
# mimalloc đã khai báo trong workspace nhưng chưa gắn `#[global_allocator]` — thêm ở bản build thử, không commit vào script này.
# Cần: curl, psql, node >= 20, systemd-run (cgroup v2), tuỳ chọn smem/pidstat. Kết quả: $OUT (mặc định ./rust-perf-<nhãn>-<profile>.txt).
# Số ghi vào docs/rust/BASELINE.md mục "Rust (X05)": lặp >= 3 lần, lấy trung vị.
set -euo pipefail
: "${TRINITY_BIN:?}" "${DATABASE_URL:?}" "${EMAIL:?}" "${PASSWORD:?}"
LABEL="${1:-local}"; PROFILE="${PROFILE:-2gb}"; OUT="${OUT:-rust-perf-$LABEL-$PROFILE.txt}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${TRINITY_HTTP_PORT:-4310}"; STUB="${STUB_PORT:-9911}"; DUR="${DURATION_S:-30}"
case "$PROFILE" in
  2gb) MEMMAX=1500M; POOL=8; WORKERS=2 ;;
  1gb) MEMMAX=900M;  POOL=4; WORKERS=1 ;;
  *) echo "PROFILE phải là 2gb hoặc 1gb" >&2; exit 2 ;;
esac
case "$PORT" in 3000|3100|4000|4100) echo "cổng $PORT bị cấm" >&2; exit 2 ;; esac
PIDS=(); cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }; trap cleanup EXIT
log() { echo "$@" | tee -a "$OUT"; }
: > "$OUT"
DB=$(psql "$DATABASE_URL" -Atc "select current_database()")
pgconn() { psql "$DATABASE_URL" -Atc "select count(*) from pg_stat_activity where datname='$DB' and pid <> pg_backend_pid()"; }
status() { awk -v k="$2" '$1==k":"{print $2}' "/proc/$1/status"; }   # kB
pss() { awk '/^Pss:/{print $2}' "/proc/$1/smaps_rollup" 2>/dev/null || echo n/a; }
mem_total() { awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo; }
swap_used() { awk '/SwapTotal/{t=$2}/SwapFree/{f=$2}END{printf "%d", (t-f)/1024}' /proc/meminfo; }

log "# X05 '$LABEL' profile=$PROFILE — $(date -u +%FT%TZ) — $(uname -sm) — RAM $(mem_total) MB — bin $(wc -c < "$TRINITY_BIN") byte"
JWT=$(openssl rand -hex 32); SVC=$(openssl rand -hex 32)
node "$ROOT/tests/load/graph-stub.mjs" >/dev/null 2>&1 & PIDS+=($!); sleep 1

log "## Khởi động"
T0=$(date +%s.%N)
UNIT="trinity-x05-$$"
systemd-run --user --scope --unit "$UNIT" -p MemoryMax="$MEMMAX" -p MemorySwapMax=0 \
  env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DATABASE_URL" JWT_SECRET="$JWT" INTERNAL_SERVICE_SECRET="$SVC" \
  TRINITY_HTTP_PORT="$PORT" MULTI_TENANT=false DB_POOL_SIZE="$POOL" WORKER_THREADS="$WORKERS" \
  FACEBOOK_GRAPH_BASE_URL="http://127.0.0.1:$STUB" STORAGE_LOCAL_ROOT="${TMPDIR:-/tmp}/x05-storage" \
  "$TRINITY_BIN" serve >"${TMPDIR:-/tmp}/x05-trinity.log" 2>&1 &
PIDS+=($!); sleep 0.3
for _ in $(seq 100); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/v1/health" && break; sleep 0.1; done
log "  tới khi health 200: $(echo "$(date +%s.%N) - $T0" | bc) s (đích 2gb ≤ 1, 1gb ≤ 2)"
PID=$(pgrep -f "$TRINITY_BIN serve" | head -1)
sleep 5
log "## Lúc rỗi (5 giây)"
log "  VmRSS=$(( $(status "$PID" VmRSS) / 1024 )) MB  PSS(kB)=$(pss "$PID")  Postgres conn=$(pgconn)"

load_case() { # $1=nhãn $2...=lệnh
  local name="$1"; shift
  log "## $name"
  local peak=0 pc=0 hwm
  ( "$@" ) | tee -a "$OUT" & local lp=$!
  while kill -0 $lp 2>/dev/null; do
    c=$(pgconn); [ "$c" -gt "$pc" ] && pc=$c
    s=$(status "$PID" VmRSS); [ "$s" -gt "$peak" ] && peak=$s; sleep 1
  done; wait $lp || true
  hwm=$(status "$PID" VmHWM)
  log "  RSS đỉnh (poll)=$((peak/1024)) MB  VmHWM=$((hwm/1024)) MB  Postgres conn đỉnh=$pc  swap=$(swap_used) MB"
}

# 1. Tải thông lượng: dùng lại run.mjs (health, contacts_20, login) ở 10 và 50 kết nối
load_case "Tải 50 kết nối ($DUR s/kịch bản)" env BASE="http://127.0.0.1:$PORT" EMAIL="$EMAIL" PASSWORD="$PASSWORD" \
  DURATION_S="$DUR" node "$ROOT/tests/load/run.mjs" "$LABEL-$PROFILE"
# 2. 10 request treo ở Graph + đăng nhập; 3. xuất lớn nhất; 4. tải lên 95 MB
load_case "Đăng nhập khi 10 request treo ở Graph" env BASE="http://127.0.0.1:$PORT" EMAIL="$EMAIL" PASSWORD="$PASSWORD" \
  node "$ROOT/tests/load/perf.mjs" login-graph-treo --label "$LABEL-$PROFILE"
load_case "Tệp xuất lớn nhất (đích < 100 s)" env BASE="http://127.0.0.1:$PORT" EMAIL="$EMAIL" PASSWORD="$PASSWORD" \
  node "$ROOT/tests/load/perf.mjs" export --label "$LABEL-$PROFILE"
load_case "Tải lên 95 MB theo phần" env BASE="http://127.0.0.1:$PORT" EMAIL="$EMAIL" PASSWORD="$PASSWORD" \
  node "$ROOT/tests/load/perf.mjs" upload-95mb --label "$LABEL-$PROFILE"

log "## Tổng máy"
log "  MemAvailable=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo) MB  swap=$(swap_used) MB  memory.peak(cgroup)=$(cat "/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/$UNIT.scope/memory.peak" 2>/dev/null || echo n/a)"
log "Xong. Dán số vào docs/rust/BASELINE.md mục 'Rust (X05)'."
