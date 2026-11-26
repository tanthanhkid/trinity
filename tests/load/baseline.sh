#!/usr/bin/env bash
# Đo baseline RAM / CPU / độ trễ của bản Node (R003). Một lệnh:
#
#   DATABASE_URL=postgresql://u:p@localhost:5432/db_rieng EMAIL=... PASSWORD=... tests/load/baseline.sh [nhãn]
#
# Yêu cầu: đã build (`pnpm --filter "./packages/*" build`, `pnpm --filter @trinity/monolith build`, `pnpm --filter web build`),
# DB riêng đã migrate + seed, redis-server, psql. Dùng DB RIÊNG — script chỉ đọc và đăng nhập, nhưng đừng trỏ vào DB thật.
# Cổng: Redis 6390, Node 4210, Next 3210 (không đụng 3000/3100/4000/4100). Kết quả ghi vào $OUT (mặc định ./baseline-<nhãn>.txt).
# Linux: thêm PSS (từ /proc/<pid>/smaps_rollup), VmHWM. macOS: chỉ RSS (ps) — PSS không có.
set -euo pipefail
: "${DATABASE_URL:?}" "${EMAIL:?}" "${PASSWORD:?}"
LABEL="${1:-local}"; OUT="${OUT:-baseline-$LABEL.txt}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RP=6390; NP=4210; WP=3210
PIDS=(); cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }; trap cleanup EXIT
DB=$(psql "$DATABASE_URL" -Atc "select current_database()")
log() { echo "$@" | tee -a "$OUT"; }
: > "$OUT"

rss_kb() { ps -o rss= -p "$1" | tr -d ' '; }
tree_rss_kb() { # tổng RSS của tiến trình và con
  local s=0 p; for p in "$1" $(pgrep -P "$1" 2>/dev/null || true); do s=$((s + $(rss_kb "$p" 2>/dev/null || echo 0))); done; echo "$s"; }
pss_kb() { [ -r "/proc/$1/smaps_rollup" ] && awk '/^Pss:/{print $2}' "/proc/$1/smaps_rollup" || echo n/a; }
cpu_s() { ps -o cputime= -p "$1" | awk -F'[:.]' '{ if (NF==3) print $1*60+$2+$3/100; else print $1*3600+$2*60+$3 }'; }
pgconn() { psql "$DATABASE_URL" -Atc "select count(*) from pg_stat_activity where datname='$DB' and pid <> pg_backend_pid()"; }
wait_http() { for _ in $(seq 60); do curl -fs -o /dev/null "$1" && return 0; sleep 1; done; echo "không lên: $1" >&2; return 1; }
snap() { # $1=tên $2=pid
  log "  $1: RSS=$(( $(tree_rss_kb "$2") / 1024 )) MB  PSS(kB)=$(pss_kb "$2")  CPU_s=$(cpu_s "$2")"; }

log "# Baseline '$LABEL' — $(date -u +%FT%TZ) — $(uname -sm) — RAM $(( $(sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/{print $2*1024}' /proc/meminfo) / 1048576 )) MB — node $(node -v)"
log "## Khởi động"
redis-server --port $RP --save "" --appendonly no --daemonize no >/dev/null 2>&1 & PIDS+=($!); sleep 1
# Bí mật ngẫu nhiên cho riêng lần chạy này (không đọc .env, không dùng bí mật thật); chạy production để đo đúng chế độ thật.
JWT=$(openssl rand -hex 32); SVC=$(openssl rand -hex 32); export INTERNAL_SERVICE_SECRET="$SVC"
ENVV=(env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DATABASE_URL" REDIS_URL="redis://127.0.0.1:$RP" NODE_ENV=production PORT=$NP MULTI_TENANT=false JWT_SECRET="$JWT" SERVICE_SECRET="$SVC" INTERNAL_SERVICE_SECRET="$SVC" CORS_ORIGIN="http://127.0.0.1:$WP" STORAGE_DRIVER=local STORAGE_LOCAL_ROOT="${TMPDIR:-/tmp}/r003-storage")
T0=$(date +%s.%N)
( cd "$ROOT" && exec "${ENVV[@]}" node apps/monolith/dist/apps/monolith/src/main.js >"${TMPDIR:-/tmp}/r003-node.log" 2>&1 ) & NODE=$!; PIDS+=($NODE)
wait_http "http://127.0.0.1:$NP/api/v1/health"
log "  Node tới khi health 200: $(echo "$(date +%s.%N) - $T0" | bc) s"
WEBCMD="$ROOT/apps/web/.next/standalone/apps/web/server.js"
[ -f "$WEBCMD" ] || { echo "Thiếu standalone Next ($WEBCMD) — build web trước" >&2; exit 2; }
( cd "$(dirname "$WEBCMD")" && exec env PORT=$WP HOSTNAME=127.0.0.1 NODE_ENV=production BACKEND_URL="http://127.0.0.1:$NP" MONOLITH_INTERNAL_URL="http://127.0.0.1:$NP" INTERNAL_SERVICE_SECRET="$SVC" SERVICE_SECRET="$SVC" NODE_OPTIONS="--require $ROOT/apps/web/peer-ip.cjs" node server.js >"${TMPDIR:-/tmp}/r003-web.log" 2>&1 ) & WEB=$!; PIDS+=($WEB)
wait_http "http://127.0.0.1:$WP/" || true
REDIS=$(pgrep -f "redis-server.*:$RP" | head -1)
sleep 5
log "## Lúc rỗi (sau 5 giây)"; snap node "$NODE"; snap next "$WEB"; snap redis "$REDIS"; log "  Kết nối Postgres: $(pgconn)"

load() { # $1=tên cấu hình $2=BASE
  log "## Tải: $1 ($2)"
  C0=$(cpu_s "$NODE"); W0=$(cpu_s "$WEB"); START=$(date +%s)
  BASE="$2" EMAIL="$EMAIL" PASSWORD="$PASSWORD" node "$ROOT/tests/load/run.mjs" "$1" | tee -a "$OUT" &
  LP=$!; PEAK=0; PN=0; PW=0; PC=0
  while kill -0 $LP 2>/dev/null; do
    a=$(tree_rss_kb "$NODE"); b=$(tree_rss_kb "$WEB"); c=$(pgconn)
    [ "$a" -gt "$PN" ] && PN=$a; [ "$b" -gt "$PW" ] && PW=$b; [ "$c" -gt "$PC" ] && PC=$c; sleep 1
  done; wait $LP || true
  EL=$(( $(date +%s) - START ))
  log "  RSS đỉnh: node=$((PN/1024)) MB next=$((PW/1024)) MB — kết nối Postgres đỉnh=$PC"
  log "  CPU trung bình: node=$(echo "($(cpu_s "$NODE") - $C0) * 100 / $EL" | bc)% next=$(echo "($(cpu_s "$WEB") - $W0) * 100 / $EL" | bc)% của 1 lõi (trong $EL s)"
}
load "node-truc-tiep" "http://127.0.0.1:$NP"
load "next-proxy-node (cau-hinh-lai-khong-co-rust)" "http://127.0.0.1:$WP"
log "## Cuối"; snap node "$NODE"; snap next "$WEB"; snap redis "$REDIS"; log "  Kết nối Postgres: $(pgconn)"
[ -r /proc/swaps ] && log "  Swap dùng: $(free -m | awk '/Swap/{print $3}') MB"
log "Kết quả: $OUT"
