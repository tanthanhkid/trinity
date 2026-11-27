#!/usr/bin/env bash
# Thử `cutover-dot.sh` bằng trinity giả và dữ liệu giả trong thư mục tạm (không đụng bản chạy thật, không cần Postgres/cargo).
#   bash scripts/ops/test-cutover-dot.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S="$HERE/cutover-dot.sh"
REPO=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d); [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0

t() { local name=$1; shift; if "$@"; then PASS=$((PASS+1)); echo "ok   $name"; else FAIL=$((FAIL+1)); echo "FAIL $name"; fi; }

mkdir -p "$T/bin" "$T/bk/cutover-1" "$T/own"
# trinity giả: mã thoát theo biến FAKE_*; check-config thật sự đòi tệp là JSON.
cat > "$T/bin/trinity" <<'X'
#!/usr/bin/env bash
case "$1" in
  check-config) python3 -c "import json,os;json.load(open(os.environ['TRINITY_OWNERSHIP_FILE']))" 2>/dev/null; exit $? ;;
  check-routes) exit "${FAKE_ROUTES:-0}" ;;
  check-invariants) exit "${FAKE_INV:-0}" ;;
esac
X
printf '#!/usr/bin/env bash\n[ -s "${@: -1}" ]\n' > "$T/bin/pg_restore"
chmod +x "$T/bin/trinity" "$T/bin/pg_restore"
echo dump > "$T/bk/cutover-1/db.dump"; (cd "$T/bk/cutover-1" && { sha256sum db.dump || shasum -a 256 db.dump; } > db.dump.sha256)

cat > "$T/routes.json" <<'X'
{"routes":[
 {"method":"GET","path":"/api/v1/health","safe_for_shadow":true,"min_samples":2},
 {"method":"GET","path":"/api/v1/settings/options","safe_for_shadow":true,"min_samples":2},
 {"method":"GET","path":"/api/v1/settings/channel-guard","safe_for_shadow":true,"min_samples":2},
 {"method":"POST","path":"/api/v1/settings/options","safe_for_shadow":false,"min_samples":2}
]}
X
mkdir -p "$T/mau"
cat > "$T/mau/ownership-dot-a.json" <<'X'
{"routes":[{"prefix":"/api/v1/health","methods":["GET"],"owner":"rust"},
 {"prefix":"/api/v1/settings","owner":"rust"},{"prefix":"/api/v1/settings/channel-guard","owner":"node"}],
 "jobs":{},"migrate":"node","web":"rust"}
X
echo '{"routes":[],"jobs":{},"migrate":"node","web":"rust"}' > "$T/own/ownership.json"
cp "$T/own/ownership.json" "$T/mac-dinh.json"

now=$(date +%s)
report() { # $1 mẫu options, $2 khác, $3 cửa sổ giờ
  cat > "$T/shadow.json" <<X
{"sample_rate":0.1,"since_unix":$((now - $3*3600)),"generated_unix":$now,"routes":[
 {"route":"GET /api/v1/health","min_samples":2,"samples":5,"different":0,"status_mismatch":0,"unshadowable":null,"diff_paths":{}},
 {"route":"GET /api/v1/settings/options","min_samples":2,"samples":$1,"different":$2,"status_mismatch":0,"unshadowable":null,"diff_paths":{"\$.a":1}},
 {"route":"GET /api/v1/settings/channel-guard","min_samples":2,"samples":0,"different":0,"status_mismatch":0,"unshadowable":null,"diff_paths":{}}]}
X
}
export PATH="$T/bin:$PATH" OWNERSHIP_FILE="$T/own/ownership.json" MAU_DIR="$T/mau" ROUTES_JSON="$T/routes.json" \
  SHADOW_REPORT_FILE="$T/shadow.json" BACKUP_DIR="$T/bk" INVARIANT_STATE="$T/inv.json" RELOAD_CMD="echo HUP >> $T/hup.log"
run() { bash "$S" "$@"; }

report 2 0 49
t "đủ điều kiện thì kiem-truoc mã 0 (route thuộc node không bị đòi mẫu)" run kiem-truoc a >"$T/o1" 2>&1
t "route chỉ thuộc đợt được liệt kê, không có POST" bash -c "! grep -q channel-guard '$T/o1' && grep -qE '[(]2/2[)]' '$T/o1'"

report 1 0 49
t "thiếu mẫu thì mã 1 và liệt kê route cần X13" bash -c "! bash '$S' kiem-truoc a >'$T/o2' 2>&1 && grep -q 'settings/options mẫu 1/2' '$T/o2' && grep -q 'X13' '$T/o2'"
report 5 1 49
t "khác biệt thì mã 1" bash -c "! bash '$S' kiem-truoc a >/dev/null 2>&1"
report 5 0 10
t "cửa sổ ngắn hơn 48 giờ thì mã 1" bash -c "! bash '$S' kiem-truoc a >/dev/null 2>&1"
report 5 0 49
FAKE_INV=1 t "bất biến đỏ thì mã 1" bash -c "! FAKE_INV=1 bash '$S' kiem-truoc a >/dev/null 2>&1"
t "thiếu dump thì mã 1" bash -c "! BACKUP_DIR='$T/trong' bash '$S' kiem-truoc a >/dev/null 2>&1"
touch -t 202001010000 "$T/bk/cutover-1/db.dump"
t "dump cũ thì mã 1" bash -c "! bash '$S' kiem-truoc a >/dev/null 2>&1"
touch "$T/bk/cutover-1/db.dump"; (cd "$T/bk/cutover-1" && { sha256sum db.dump || shasum -a 256 db.dump; } > db.dump.sha256)

t "bat -n không đổi gì" bash -c "bash '$S' bat a -n >/dev/null 2>&1 && cmp -s '$T/own/ownership.json' '$T/mac-dinh.json'"
t "bat sao lưu rồi ghép mẫu và nạp lại" bash -c "bash '$S' bat a >'$T/o3' 2>&1 && cmp -s '$T/own/ownership.json' '$T/mau/ownership-dot-a.json' && grep -q HUP '$T/hup.log' && ls '$T'/bk/cutover-*/ownership.before.json >/dev/null"
t "lui khôi phục tệp trước" bash -c "bash '$S' lui a >/dev/null 2>&1 && cmp -s '$T/own/ownership.json' '$T/mac-dinh.json' && [ \$(wc -l < '$T/hup.log') -eq 2 ]"
t "lui không có bản sao lưu thì từ chối" bash -c "rm -f '$T'/bk/ownership-truoc-dot-*.path; ! bash '$S' lui a >/dev/null 2>&1"
t "lui --ve-mac-dinh chạy được" bash -c "bash '$S' lui a --ve-mac-dinh >/dev/null 2>&1"
t "mẫu hỏng thì bat/lui không đổi tệp" bash -c "echo '{' > '$T/hong.json'; cp '$T/own/ownership.json' '$T/truoc.json'; ! bash '$S' lui a --tu '$T/hong.json' >/dev/null 2>&1 && cmp -s '$T/own/ownership.json' '$T/truoc.json'"
t "đợt lạ bị từ chối" bash -c "! bash '$S' bat z >/dev/null 2>&1"
# mẫu thật của repo nạp được bằng bộ khớp: đợt e có route safe_for_shadow
t "bộ khớp chạy được trên hợp đồng và mẫu thật của repo (đợt a..e, mã 0)" bash -c '
  eval "$(sed -n "/^wave_routes()/,/^}/p" "$1")"; ROUTES_JSON="$2/server/contracts/routes.json"
  for d in a b c d e; do wave_routes "$2/deploy/hybrid/mau/ownership-dot-$d.json" "" >/dev/null || exit 1; done' _ "$S" "$REPO"
echo "ĐẠT $PASS, HỎNG $FAIL"; [ "$FAIL" = 0 ]
