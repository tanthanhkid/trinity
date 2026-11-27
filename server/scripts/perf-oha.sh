#!/usr/bin/env bash
# Đo tải GET /api/v1/contacts có token bằng `oha` ở nhiều mức đồng thời, in bảng rps/p50/p95/p99/lỗi (+ RSS đỉnh nếu có PID).
# Dùng:  server/scripts/perf-oha.sh BASE_URL EMAIL PASS [PID]
# Env:   LEVELS="50 200 400" (mức đồng thời), DURATION=30s, PATH_URL=/api/v1/contacts, WARMUP=3s
# Cần: bash, oha, curl, python3. PID: PID của `trinity serve` cùng máy; RSS lấy mẫu mỗi giây bằng `ps -o rss=`.
# Token chỉ nằm trong biến shell và tiêu đề gửi đi, KHÔNG in ra. Bị giới hạn đăng nhập thì chờ rồi chạy lại.
set -euo pipefail
[ $# -ge 3 ] || { echo "dùng: $0 BASE_URL EMAIL PASS [PID]" >&2; exit 2; }
BASE="${1%/}"; EMAIL="$2"; PASS="$3"; PID="${4:-}"
LEVELS="${LEVELS:-50 200 400}"; DURATION="${DURATION:-30s}"; WARMUP="${WARMUP:-3s}"; PATH_URL="${PATH_URL:-/api/v1/contacts}"
command -v oha >/dev/null || { echo "thiếu oha (brew install oha)" >&2; exit 2; }

body=$(EMAIL="$EMAIL" PASS="$PASS" python3 -c 'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PASS"]}))')
resp=$(curl -sS -X POST "$BASE/api/v1/auth/login" -H 'content-type: application/json' -d "$body")
TOKEN=$(printf '%s' "$resp" | python3 -c '
import json,sys
j=json.load(sys.stdin)
for d in (j, j.get("data") or {}):
    for k in ("access_token","accessToken","token"):
        if isinstance(d,dict) and d.get(k): print(d[k]); sys.exit(0)
sys.exit(1)') || { echo "đăng nhập lỗi (không lấy được token)" >&2; exit 1; }

rss_peak() { # $1=tệp mẫu → in MB đỉnh
  sort -n "$1" | tail -1 | awk '{printf "%.0f", $1/1024}'
}
[ -n "$PID" ] && echo "RSS nghỉ: $(( $(ps -o rss= -p "$PID" | tr -d ' ') / 1024 )) MB (PID $PID)"
echo "máy: $(uname -sm), đo $DURATION/mức, $PATH_URL"
printf '%-6s %9s %9s %9s %9s %9s %9s\n' conc rps p50_ms p95_ms p99_ms loi RSS_dinh_MB

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for c in $LEVELS; do
  oha -z "$WARMUP" -c "$c" --no-tui -H "Authorization: Bearer $TOKEN" "$BASE$PATH_URL" >/dev/null 2>&1 || true
  : > "$tmp/rss"
  if [ -n "$PID" ]; then
    ( while kill -0 $$ 2>/dev/null; do ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' >> "$tmp/rss" || true; sleep 1; done ) &
    sampler=$!
  fi
  oha -z "$DURATION" -c "$c" --no-tui --output-format json -H "Authorization: Bearer $TOKEN" "$BASE$PATH_URL" > "$tmp/out.json" 2>/dev/null || true
  [ -n "${sampler:-}" ] && { kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true; unset sampler; }
  rss="-"; [ -n "$PID" ] && [ -s "$tmp/rss" ] && rss=$(rss_peak "$tmp/rss")
  python3 - "$tmp/out.json" "$c" "$rss" <<'PY'
import json,sys
f,c,rss=sys.argv[1:4]
try: j=json.load(open(f))
except Exception: print(f"{c:<6} (oha không trả JSON)"); sys.exit(0)
s=j["summary"]; p=j.get("latencyPercentiles",{})
ms=lambda k: f"{(p.get(k) or 0)*1000:.1f}"
codes=j.get("statusCodeDistribution",{})
# Các request đang bay lúc hết giờ bị oha báo "aborted due to deadline": không tính là lỗi.
errs={k:v for k,v in j.get("errorDistribution",{}).items() if "deadline" not in k}
total=sum(codes.values())+sum(errs.values()) or 1
bad=sum(v for k,v in codes.items() if not k.startswith("2"))+sum(errs.values())
print(f"{c:<6} {s['requestsPerSec']:9.0f} {ms('p50'):>9} {ms('p95'):>9} {ms('p99'):>9} {100*bad/total:8.1f}% {rss:>9}")
PY
done
