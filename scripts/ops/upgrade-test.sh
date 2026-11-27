#!/usr/bin/env bash
# X14 — thử nâng cấp một bản cài Docker Compose có dữ liệu lên bản dựng từ một nhánh cho trước.
#
#   scripts/ops/upgrade-test.sh --new-ref <nhánh|tag|sha> [--old-ref <tag>] [--api-port 4000|4100]
#                               [--mode auto|node|rust] [--tunnel-file <tệp compose ghép>] [--keep]
#
# Các bước (docs/rust/ISSUES.md X14, docs/upgrade-from-node.md):
#   1. Giải nén bản phát hành gần nhất (hoặc --old-ref) và nhánh mới bằng `git archive` (không đụng cây làm việc).
#   2. Dựng bản cũ bằng compose cũ, `.env` kiểu cũ (PORT=4000, LEGAL_COMPANY_NAME, cờ *_TRUST_* mà compose cũ không
#      chuyển vào container, API_PORT tuỳ chọn), reverse proxy Caddy đúng theo docs/deployment.md cũ:
#      /notif-ws/* → cổng API của host, còn lại → cổng web.
#   3. Tạo dữ liệu: đăng nhập (giữ phiên cũ), tải ảnh lên, gửi một thông báo.
#   4. Nâng cấp tại chỗ: cùng project compose (giữ volume), cùng `.env`, `up -d --build --remove-orphans`.
#   5. Kiểm (mỗi dòng PASS/FAIL, thoát 1 nếu có FAIL).
#
# Chế độ: `node` (nhánh còn compose Node: main hiện tại, Node -> Node) hoặc `rust` (nhánh sau X06: service `trinity`,
# không còn `api`/`web`). `auto` đọc danh sách service của compose trong nhánh mới.
# Chỉ chạy trên máy có Docker (runner CI Linux); KHÔNG chạy trên Mac của người phát triển. Cần: docker compose >= 2.24,
# git, curl, jq, openssl, node >= 18 (cho ca socket), mạng ra ngoài (kéo image, npm install socket.io-client).
#
# Mã thoát: 0 = mọi kiểm đạt; 1 = có kiểm hỏng; 2 = thiếu điều kiện / tham số / dựng không lên.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

NEW_REF=""
OLD_REF=""
API_PORT=4000
MODE=auto
TUNNEL_FILE=""
KEEP=0
WEB_PORT="${UPGRADE_WEB_PORT:-13000}"
PROXY_PORT="${UPGRADE_PROXY_PORT:-18080}"
WAIT_SECS="${UPGRADE_WAIT_SECS:-420}"

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --new-ref) NEW_REF="${2:?}"; shift 2 ;;
    --old-ref) OLD_REF="${2:?}"; shift 2 ;;
    --api-port) API_PORT="${2:?}"; shift 2 ;;
    --mode) MODE="${2:?}"; shift 2 ;;
    --tunnel-file) TUNNEL_FILE="${2:?}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "tham số lạ: $1" >&2; usage ;;
  esac
done
[ -n "$NEW_REF" ] || { echo "thiếu --new-ref" >&2; usage; }
case "$MODE" in auto|node|rust) ;; *) echo "--mode phải là auto|node|rust" >&2; exit 2 ;; esac
case "$API_PORT" in ''|*[!0-9]*) echo "--api-port phải là số" >&2; exit 2 ;; esac

for bin in docker git curl jq openssl node npm; do
  command -v "$bin" >/dev/null 2>&1 || { echo "thiếu lệnh: $bin" >&2; exit 2; }
done
docker compose version >/dev/null 2>&1 || { echo "thiếu docker compose" >&2; exit 2; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "cần node >= 18" >&2; exit 2; }

cd "$REPO_ROOT"
if [ -z "$OLD_REF" ]; then
  OLD_REF="$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
  [ -n "$OLD_REF" ] || { echo "không có tag v* (checkout cần fetch-depth: 0 và tags)" >&2; exit 2; }
fi
git rev-parse --verify --quiet "$OLD_REF^{commit}" >/dev/null || { echo "không thấy --old-ref $OLD_REF" >&2; exit 2; }
# Nhánh ưu tiên bản trên origin (checkout CI chỉ có nhánh được dispatch ở dạng cục bộ).
git rev-parse --verify --quiet "origin/$NEW_REF^{commit}" >/dev/null && NEW_REF="origin/$NEW_REF"
git rev-parse --verify --quiet "$NEW_REF^{commit}" >/dev/null || { echo "không thấy --new-ref" >&2; exit 2; }

SUFFIX="$(openssl rand -hex 3)"
PROJECT="trinity-upg-$SUFFIX"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/trinity-upgrade.XXXXXX")"
OLD_DIR="$WORK/old"
NEW_DIR="$WORK/new"
TOOLS="$WORK/tools"
CADDY="$PROJECT-caddy"
BASE="http://127.0.0.1:$PROXY_PORT"
mkdir -p "$OLD_DIR" "$NEW_DIR" "$TOOLS"

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
info() { echo "INFO  $*"; }
check() { local msg="$1"; shift; if "$@"; then pass "$msg"; else fail "$msg"; fi; }

cleanup() {
  local rc=$?
  set +e
  if [ "$KEEP" = 1 ]; then
    echo "INFO  giữ lại: project=$PROJECT, thư mục=$WORK (dọn: docker compose -p $PROJECT down -v; docker rm -f $CADDY)"
    return
  fi
  # Chỉ dọn đúng thứ script này tạo (project và container mang hậu tố ngẫu nhiên của lần chạy).
  if [ -d "$NEW_DIR" ] && [ -f "$NEW_DIR/docker-compose.yml" ]; then
    (cd "$NEW_DIR" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1)
  fi
  (cd "$OLD_DIR" && docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1)
  docker rm -f "$CADDY" >/dev/null 2>&1
  rm -rf "$WORK"
  return $rc
}
trap cleanup EXIT

dc_old() { (cd "$OLD_DIR" && docker compose -p "$PROJECT" "$@"); }
dc_new() {
  local files=(-f docker-compose.yml)
  [ -n "$TUNNEL_FILE" ] && files+=(-f "$TUNNEL_FILE")
  (cd "$NEW_DIR" && docker compose -p "$PROJECT" "${files[@]}" "$@")
}

# ---------------------------------------------------------------------------------------------------------------
# 1. Giải nén hai bản
# ---------------------------------------------------------------------------------------------------------------
echo "== Bản cũ: $OLD_REF · bản mới: $NEW_REF ($(git rev-parse --short "$NEW_REF")) · API_PORT=$API_PORT · project $PROJECT"
git archive "$OLD_REF" | tar -x -C "$OLD_DIR"
git archive "$NEW_REF" | tar -x -C "$NEW_DIR"
[ -f "$OLD_DIR/docker-compose.yml" ] && [ -f "$NEW_DIR/docker-compose.yml" ] || { echo "thiếu docker-compose.yml" >&2; exit 2; }
if [ -n "$TUNNEL_FILE" ] && [ ! -f "$NEW_DIR/$TUNNEL_FILE" ]; then
  echo "bản mới không có tệp ghép tunnel: $TUNNEL_FILE" >&2; exit 2
fi

if [ "$MODE" = auto ]; then
  services="$(cd "$NEW_DIR" && docker compose -p "$PROJECT" config --services 2>/dev/null || true)"
  if echo "$services" | grep -qx 'trinity' && ! echo "$services" | grep -qx 'api'; then MODE=rust; else MODE=node; fi
fi
echo "== Chế độ nâng cấp: $MODE${TUNNEL_FILE:+ (tệp ghép tunnel: $TUNNEL_FILE)}"

# ---------------------------------------------------------------------------------------------------------------
# 2. .env kiểu cũ + reverse proxy kiểu cũ
# ---------------------------------------------------------------------------------------------------------------
ENV_FILE="$OLD_DIR/.env"
if [ -f "$OLD_DIR/.env.example" ]; then cp "$OLD_DIR/.env.example" "$ENV_FILE"; else : > "$ENV_FILE"; fi
setenv() { # KEY VALUE — thay dòng KEY= (kể cả dòng đang comment) hoặc thêm cuối tệp
  local key="$1" val="$2" tmp="$ENV_FILE.tmp"
  if grep -Eq "^#? ?${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{done=0} { if (!done && $0 ~ "^#? ?" k "=") { print k "=" v; done=1 } else print }' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

ADMIN_EMAIL="admin-upg@example.com"
ADMIN_PASS="$(openssl rand -hex 12)"
LEGAL_NAME="Cong ty Nang Cap X14 $SUFFIX"
setenv POSTGRES_PASSWORD "$(openssl rand -hex 16)"
setenv JWT_SECRET "$(openssl rand -hex 32)"
setenv SERVICE_SECRET "$(openssl rand -hex 32)"
setenv INTERNAL_SERVICE_SECRET "$(grep -E '^SERVICE_SECRET=' "$ENV_FILE" | head -n 1 | cut -d= -f2-)"
setenv INTEGRATIONS_SECRET_KEY "$(openssl rand -base64 32)"
setenv SEED_ADMIN_EMAIL "$ADMIN_EMAIL"
setenv SEED_ADMIN_PASSWORD "$ADMIN_PASS"
setenv SEED_DEMO_DATA false
setenv CORS_ORIGIN "$BASE"
setenv WEB_PORT "$WEB_PORT"
setenv API_PORT "$API_PORT"
# Kiểu cũ: PORT=4000 là biến của bản Node; compose cũ không chuyển LEGAL_* và cờ *_TRUST_* vào container.
setenv PORT 4000
setenv LEGAL_COMPANY_NAME "$LEGAL_NAME"
setenv ATTENDANCE_TRUST_CF_IP true
setenv LOGIN_WIFI_TRUST_CF_IP true
setenv ATTENDANCE_TRUST_PROXY_HEADERS true
setenv LOGIN_WIFI_TRUST_PROXY_HEADERS true
setenv TRUSTED_PROXY none

cat > "$WORK/Caddyfile" <<EOF
{
	admin off
	auto_https off
}
:$PROXY_PORT {
	reverse_proxy /notif-ws/* 127.0.0.1:$API_PORT
	reverse_proxy 127.0.0.1:$WEB_PORT
}
EOF
docker run -d --name "$CADDY" --network host -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.8.4-alpine caddy run --config /etc/caddy/Caddyfile >/dev/null

# Công cụ ca socket
cp "$REPO_ROOT/scripts/ops/upgrade/ws-check.mjs" "$TOOLS/ws-check.mjs"
(cd "$TOOLS" && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --silent socket.io-client@4.8.1)

# ---------------------------------------------------------------------------------------------------------------
# Hàm HTTP
# ---------------------------------------------------------------------------------------------------------------
BODY="$WORK/body.json"
http() { # METHOD URL [curl args…] → in mã HTTP, thân ở $BODY
  local m="$1" u="$2"; shift 2
  curl -sS -o "$BODY" -w '%{http_code}' -X "$m" --max-time 30 "$@" "$u" || echo 000
}
wait_health() { # URL
  for _ in $(seq $((WAIT_SECS / 5))); do
    [ "$(http GET "$1" || true)" = 200 ] && return 0
    sleep 5
  done
  return 1
}
login() { # → đặt TOKEN, REFRESH
  local code
  code="$(http POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" '{email:$e,password:$p}')")"
  [ "$code" = 200 ] || [ "$code" = 201 ] || return 1
  TOKEN="$(jq -r '(.data? // .) | .access_token // empty' "$BODY")"
  REFRESH="$(jq -r '(.data? // .) | .refresh_token // empty' "$BODY")"
  [ -n "$TOKEN" ]
}
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
upload_png() { # TÊN-TỆP → đặt IMAGE_URL
  local code
  code="$(http POST "$BASE/api/v1/products/upload-image" -H "Authorization: Bearer $TOKEN" -F "file=@$1;type=image/png")"
  [ "$code" = 201 ] || [ "$code" = 200 ] || { echo "  upload-image trả $code" >&2; return 1; }
  IMAGE_URL="$(jq -r '(.data? // .) | .image_url // empty' "$BODY")"
  [ -n "$IMAGE_URL" ]
}
same_file() { # URL SHA
  curl -sS --max-time 30 -o "$WORK/dl.bin" "$BASE$1" && [ "$(sha_of "$WORK/dl.bin")" = "$2" ]
}
# PNG 1×1 hợp lệ + vài byte ngẫu nhiên ở cuối (hầu hết bộ đọc bỏ qua) để mỗi tệp có SHA riêng.
make_png() { # TÊN-TỆP
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$1"
  openssl rand 16 >> "$1"
}
pg_scalar() { # SQL
  dc_new exec -T postgres psql -U "${POSTGRES_USER:-trinity}" -d "${POSTGRES_DB:-trinity}" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------------------------------------------
# 3. Dựng bản cũ + tạo dữ liệu
# ---------------------------------------------------------------------------------------------------------------
echo "== Dựng bản cũ ($OLD_REF)"
dc_old up -d --build
wait_health "$BASE/api/v1/health" || { dc_old logs --tail 80 >&2; echo "bản cũ không lên sau ${WAIT_SECS}s" >&2; exit 2; }
login || { echo "không đăng nhập được trên bản cũ" >&2; exit 2; }
OLD_TOKEN="$TOKEN"; OLD_REFRESH="$REFRESH"
[ "$(http GET "$BASE/api/v1/auth/me" -H "Authorization: Bearer $OLD_TOKEN")" = 200 ] || { echo "/auth/me trên bản cũ không trả 200" >&2; exit 2; }
USER_ID="$(jq -r '(.data? // .) | .id // .user.id // empty' "$BODY")"
[ -n "$USER_ID" ] || { echo "không đọc được id người dùng từ /auth/me" >&2; exit 2; }

make_png "$WORK/old.png"
OLD_SHA="$(sha_of "$WORK/old.png")"
upload_png "$WORK/old.png" || { echo "không tải được ảnh trên bản cũ" >&2; exit 2; }
OLD_IMAGE_URL="$IMAGE_URL"
same_file "$OLD_IMAGE_URL" "$OLD_SHA" || { echo "ảnh vừa tải lên bản cũ không đọc lại được" >&2; exit 2; }
OLD_MARKER="x14-cu-$SUFFIX"
[ "$(http POST "$BASE/api/v1/notifications/send" -H 'Content-Type: application/json' -H "Authorization: Bearer $OLD_TOKEN" \
  -d "$(jq -n --argjson u "$USER_ID" --arg m "$OLD_MARKER" '{user_id:$u,channel:"in_app",title:$m,body:$m}')")" = 201 ] \
  || info "bản cũ không nhận POST /notifications/send (201); ca dữ liệu thông báo cũ sẽ bỏ qua"
echo "== Dữ liệu cũ: user $USER_ID, ảnh $OLD_IMAGE_URL, thông báo $OLD_MARKER"

# ---------------------------------------------------------------------------------------------------------------
# 4. Nâng cấp tại chỗ
# ---------------------------------------------------------------------------------------------------------------
echo "== Nâng cấp lên $NEW_REF (giữ .env và volume, không down bản cũ — như người dùng làm theo docs)"
cp "$ENV_FILE" "$NEW_DIR/.env"
if [ -n "$TUNNEL_FILE" ]; then
  # Người dùng tunnel theo tài liệu nâng cấp: đặt TRUSTED_PROXY=cloudflare-tunnel trong .env trước khi lên bản mới.
  ENV_FILE="$NEW_DIR/.env"
  setenv TRUSTED_PROXY cloudflare-tunnel
fi
UPGRADE_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dc_new up -d --build --remove-orphans
if ! wait_health "$BASE/api/v1/health"; then
  dc_new logs --tail 120 >&2 || true
  echo "bản mới không lên sau ${WAIT_SECS}s" >&2
  exit 2
fi
echo "== Bản mới đã lên, bắt đầu kiểm"

# ---------------------------------------------------------------------------------------------------------------
# 5. Kiểm
# ---------------------------------------------------------------------------------------------------------------
# 5.1 Phiên cũ: access token còn hạn thì /auth/me 200; hết hạn (nâng cấp lâu) thì refresh token cũ phải đổi được.
old_session_ok() {
  local code
  code="$(http GET "$BASE/api/v1/auth/me" -H "Authorization: Bearer $OLD_TOKEN")"
  [ "$code" = 200 ] && return 0
  info "access token cũ trả $code; thử refresh token cũ"
  [ -n "$OLD_REFRESH" ] || return 1
  code="$(http POST "$BASE/api/v1/auth/refresh" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg r "$OLD_REFRESH" '{refresh_token:$r}')")"
  [ "$code" = 200 ] || [ "$code" = 201 ]
}
check "đăng nhập bằng phiên cũ (access token hoặc refresh token trước nâng cấp)" old_session_ok
check "đăng nhập lại bằng mật khẩu cũ" login

# 5.2 Tệp cũ còn mở được, tệp mới tải lên được (quyền ghi), cả hai volume ghi được bằng uid 1000.
check "mở được tệp đã tải lên trước nâng cấp ($OLD_IMAGE_URL)" same_file "$OLD_IMAGE_URL" "$OLD_SHA"
make_png "$WORK/new.png"
NEW_SHA="$(sha_of "$WORK/new.png")"
new_upload_ok() { upload_png "$WORK/new.png" && same_file "$IMAGE_URL" "$NEW_SHA"; }
check "tải tệp mới lên được và đọc lại đúng (không lỗi quyền ghi)" new_upload_ok
volume_writable() { # volume cuối tên
  docker run --rm -u 1000:1000 -v "${PROJECT}_$1:/v" alpine:3.20 sh -c 'touch /v/.x14-write && rm /v/.x14-write'
}
check "volume uploads ghi được bằng uid 1000" volume_writable uploads
check "volume storage ghi được bằng uid 1000" volume_writable storage

# 5.3 Dữ liệu cũ còn
if [ "$(http GET "$BASE/api/v1/notifications?limit=100" -H "Authorization: Bearer $TOKEN")" = 200 ]; then
  check "thông báo tạo trước nâng cấp còn trong DB" grep -q "$OLD_MARKER" "$BODY"
else
  fail "GET /notifications không trả 200 sau nâng cấp"
fi

# 5.4 Chuông realtime qua luật /notif-ws → cổng API cũ (API_PORT=$API_PORT)
check "client nhận notification:new trong 1 giây qua luật /notif-ws cũ (API_PORT=$API_PORT)" \
  node "$TOOLS/ws-check.mjs" "$BASE" "$TOKEN" "$USER_ID" "x14-moi-$SUFFIX"

# 5.5 Cổng, .env cũ, cờ cũ (chỉ có nghĩa với bản Rust)
if [ "$MODE" = rust ]; then
  check "bản mới nghe cổng 3000 dù .env cũ có PORT=4000 (qua cổng web đã công bố $WEB_PORT)" \
    test "$(http GET "http://127.0.0.1:$WEB_PORT/api/v1/health")" = 200
  if [ -z "$TUNNEL_FILE" ]; then
    check "cổng tương thích $API_PORT trả /api/v1/health" \
      test "$(http GET "http://127.0.0.1:$API_PORT/api/v1/health")" = 200
  fi
  check "/privacy hiện LEGAL_COMPANY_NAME của .env cũ" bash -c \
    "curl -sS --max-time 30 '$BASE/privacy' | grep -qF '$LEGAL_NAME'"
  LOGS="$WORK/new.log"
  dc_new logs --no-color --since "$UPGRADE_START" > "$LOGS" 2>&1 || true
  check "log cảnh báo cờ *_TRUST_* cũ không còn tác dụng và nhắc đặt TRUSTED_PROXY" bash -c \
    "grep -E 'TRUST_(CF_IP|PROXY_HEADERS)' '$LOGS' | grep -q 'TRUSTED_PROXY'"
  if grep -Eq '\bPORT\b' "$LOGS"; then pass "log có cảnh báo về biến PORT bị bỏ qua"; else info "không thấy cảnh báo về PORT trong log (không bắt buộc)"; fi
else
  info "chế độ node: bỏ ca cổng 3000 của Rust, /privacy theo LEGAL_COMPANY_NAME và cảnh báo cờ cũ (compose Node không chuyển các biến này)"
  check "web nghe cổng đã công bố $WEB_PORT" test "$(http GET "http://127.0.0.1:$WEB_PORT/api/v1/health")" = 200
fi

# 5.6 Cổng $API_PORT không tin header từ ngoài: đăng nhập vào thẳng cổng đó kèm CF-Connecting-IP / X-Forwarded-For giả,
# IP giả không được lọt vào nhật ký đăng nhập. (Ca tunnel: TRUSTED_PROXY=cloudflare-tunnel; không tin vẫn phải đúng.)
FORGED_IP="203.0.113.77"
forged_code="$(http POST "http://127.0.0.1:$API_PORT/api/v1/auth/login" -H 'Content-Type: application/json' \
  -H "CF-Connecting-IP: $FORGED_IP" -H "X-Forwarded-For: $FORGED_IP" -H "X-Real-IP: $FORGED_IP" \
  -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" '{email:$e,password:$p}')" || true)"
case "$forged_code" in
  200|201)
    forged_rows="$(pg_scalar "SELECT count(*) FROM audit_logs WHERE ip_address = '$FORGED_IP'" || true)"
    if [ -z "$forged_rows" ]; then info "không đọc được audit_logs (psql); bỏ qua kiểm IP giả"
    else check "cổng $API_PORT không tin header IP giả (audit_logs không có $FORGED_IP)" test "$forged_rows" = 0; fi ;;
  000)
    if [ -n "$TUNNEL_FILE" ]; then pass "cổng $API_PORT đóng với kết nối ngoài (chấp nhận được với tệp ghép tunnel)"
    else fail "cổng $API_PORT không nhận kết nối"; fi ;;
  *) info "cổng $API_PORT trả $forged_code cho đăng nhập kèm header giả (không phải 200/201): coi là không tin header" ;;
esac
if [ -n "$TUNNEL_FILE" ]; then
  check "tệp ghép tunnel: bản mới lên đủ (trang chính qua $BASE trả health 200)" test "$(http GET "$BASE/api/v1/health")" = 200
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "== ĐẠT: mọi kiểm nâng cấp $OLD_REF -> $NEW_REF ($MODE) đều đạt"; else echo "== HỎNG: $FAILS kiểm không đạt"; fi
[ "$FAILS" -eq 0 ]
