#!/usr/bin/env bash
# Công cụ vận hành bật/lui từng đợt a–e (X02a–X02e, #256–#260; PLAN 6.5, 6.6; runbook `docs/runbooks/cutover-cac-dot.md`).
#
#   scripts/ops/cutover-dot.sh kiem-truoc <a|b|c|d|e>     # CHỈ ĐỌC: đủ điều kiện bật chưa (mã 0 = đủ)
#   scripts/ops/cutover-dot.sh bat <đợt> [-n] [--khong-hup]   # kiểm trước, sao lưu tệp sở hữu, ghép mẫu đợt, nạp lại
#   scripts/ops/cutover-dot.sh lui <đợt> [-n] [--khong-hup] [--tu <tệp>] [--ve-mac-dinh]   # khôi phục tệp sở hữu trước đợt
#
# Bản này KHÔNG dump DB và KHÔNG chụp storage/uploads (làm theo `cutover.md` mục 2 ngay trước khi bật); `kiem-truoc` chỉ kiểm bản dump
# gần nhất có mặt. Không bao giờ khôi phục đè DB. Tệp sở hữu được thay bằng `mv` nguyên tử cùng thư mục rồi `SIGHUP`, không khởi động lại tiến trình.
#
# Env (đều có mặc định):
#   TRINITY_BIN           lệnh trinity (mặc định `trinity`)
#   OWNERSHIP_FILE        tệp sở hữu đang chạy (mặc định deploy/hybrid/ownership.json)
#   MAU_DIR               thư mục mẫu (mặc định deploy/hybrid/mau)
#   ROUTES_JSON           hợp đồng route (mặc định server/contracts/routes.json)
#   SHADOW_REPORT_FILE    báo cáo shadow của `serve` (mặc định ./shadow-report.json)
#   MIN_SHADOW_HOURS      cửa sổ shadow tối thiểu (mặc định 48)
#   BACKUP_DIR            nơi chứa cutover-<ts>/db.dump (+ db.dump.sha256) và bản sao tệp sở hữu (mặc định /srv/backup)
#   MAX_DUMP_AGE_HOURS    tuổi tối đa của bản dump (mặc định 12)
#   INVARIANT_STATE       tệp mốc X11 (mặc định /var/lib/trinity/invariants.json)
#   RELOAD_CMD            lệnh nạp lại tệp sở hữu (mặc định `kill -HUP "$(pidof trinity)"`; Docker: `docker compose ... kill -s HUP trinity`)
# Mã thoát: 0 xong/đủ điều kiện; 1 chưa đủ điều kiện hoặc bước lỗi (không đổi gì); 2 dùng sai / thiếu công cụ.
set -euo pipefail

ME=$(basename "$0")
TRINITY_BIN="${TRINITY_BIN:-trinity}"
OWNERSHIP_FILE="${OWNERSHIP_FILE:-deploy/hybrid/ownership.json}"
MAU_DIR="${MAU_DIR:-deploy/hybrid/mau}"
ROUTES_JSON="${ROUTES_JSON:-server/contracts/routes.json}"
SHADOW_REPORT_FILE="${SHADOW_REPORT_FILE:-./shadow-report.json}"
MIN_SHADOW_HOURS="${MIN_SHADOW_HOURS:-48}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backup}"
MAX_DUMP_AGE_HOURS="${MAX_DUMP_AGE_HOURS:-12}"
INVARIANT_STATE="${INVARIANT_STATE:-/var/lib/trinity/invariants.json}"
RELOAD_CMD="${RELOAD_CMD:-}"

die() { echo "$ME: $*" >&2; exit "${2:-2}"; }
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
need() { command -v "$1" >/dev/null 2>&1 || die "thiếu công cụ: $1"; }

DOT_LIST="a b c d e"
prev_dot() { case "$1" in a) echo "";; b) echo a;; c) echo b;; d) echo c;; e) echo d;; esac; }
mau_of() { echo "$MAU_DIR/ownership-dot-$1.json"; }
valid_dot() { case "$1" in a|b|c|d|e) return 0;; *) return 1;; esac; }
pointer_of() { echo "$BACKUP_DIR/ownership-truoc-dot-$1.path"; }

# Route của đợt: safe_for_shadow theo hợp đồng, thuộc `rust` ở mẫu đợt này mà chưa thuộc `rust` ở mẫu đợt trước
# (đợt a: so với "mọi thứ thuộc Node"). Luật khớp như `trinity-kernel` ownership: tiền tố theo đoạn, dài nhất thắng,
# dòng có methods thắng dòng mọi phương thức cùng tiền tố. In `GET /đường/dẫn` mỗi dòng.
wave_routes() { # $1 mẫu đợt, $2 mẫu đợt trước hoặc rỗng
  python3 -I - "$ROUTES_JSON" "$1" "${2:-}" <<'PY'
import json, sys
routes = json.load(open(sys.argv[1]))["routes"]
def load(p):
    return json.load(open(p))["routes"] if p else []
def owner(rules, method, path):
    best, key = "node", (-1, -1)
    for r in rules:
        pre = r["prefix"]
        if pre != "/" and not (path == pre or path.startswith(pre + "/")):
            continue
        ms = r.get("methods")
        if ms is not None and method not in [m.upper() for m in ms]:
            continue
        k = (len(pre), 1 if ms is not None else 0)
        if k > key:
            best, key = r["owner"], k
    return best
cur, prev = load(sys.argv[2]), load(sys.argv[3])
out = []
for r in routes:
    if not r.get("safe_for_shadow") or r.get("deprecated"):
        continue
    m, p = r["method"].upper(), r["path"]
    if owner(cur, m, p) == "rust" and owner(prev, m, p) != "rust":
        out.append(f"{m} {p}")
print("\n".join(sorted(set(out))))
PY
}

# Đối chiếu route của đợt với báo cáo shadow. In: dòng `THIEU|KHAC|KHONG|OK <route> ...`; mã 0 luôn, kết luận qua dòng cuối `TONG ...`.
shadow_check() { # $1 tệp danh sách route
  python3 -I - "$SHADOW_REPORT_FILE" "$1" "$MIN_SHADOW_HOURS" <<'PY'
import json, sys, time
rep = json.load(open(sys.argv[1]))
wave = [l.strip() for l in open(sys.argv[2]) if l.strip()]
hours = float(sys.argv[3])
rows = {r["route"]: r for r in rep.get("routes", [])}
since, gen = rep.get("since_unix", 0), rep.get("generated_unix", 0)
window = (gen - since) / 3600.0
print(f"CUASO {window:.1f} {hours:g}")
if time.time() - gen > 300:
    print("CU báo cáo shadow đã cũ (> 5 phút): serve có thể đã dừng")
bad = missing = ok = 0
for route in wave:
    r = rows.get(route)
    if r is None:
        print(f"THIEU {route} (không có trong báo cáo: chưa bật shadow hoặc không shadow được)"); missing += 1; continue
    s, mn = r.get("samples", 0), r.get("min_samples", 0)
    if r.get("unshadowable"):
        print(f"KHONG {route} KHÔNG SHADOW ĐƯỢC: {r['unshadowable']}"); bad += 1
    elif r.get("different", 0) or r.get("status_mismatch", 0):
        paths = ",".join(sorted(r.get("diff_paths", {}))) or "-"
        print(f"KHAC {route} khác {r.get('different',0)} lệch mã {r.get('status_mismatch',0)} tại {paths}"); bad += 1
    elif s < mn:
        print(f"THIEU {route} mẫu {s}/{mn}"); missing += 1
    else:
        ok += 1
print(f"TONG {len(wave)} {ok} {missing} {bad} {1 if window >= hours else 0}")
PY
}

FAILS=0
ok_()   { echo "  [ĐẠT] $*"; }
fail_() { echo "  [CHƯA] $*"; FAILS=$((FAILS + 1)); }

kiem_truoc() { # $1 đợt
  local dot=$1 mau prev prevmau tmp
  mau=$(mau_of "$dot"); prev=$(prev_dot "$dot")
  need python3
  [ -f "$mau" ] || die "không có mẫu $mau"
  [ -f "$ROUTES_JSON" ] || die "không có $ROUTES_JSON"
  prevmau=""; [ -n "$prev" ] && prevmau=$(mau_of "$prev")
  echo "== kiểm trước đợt $dot (mẫu $mau) =="

  echo "1. Mẫu hợp lệ"
  if TRINITY_OWNERSHIP_FILE="$mau" "$TRINITY_BIN" check-config >/dev/null 2>&1; then ok_ "check-config nạp được mẫu"
  else fail_ "check-config không nạp được mẫu (chạy lại tay để xem lỗi)"; fi
  if "$TRINITY_BIN" check-routes >/dev/null 2>&1; then ok_ "check-routes: độ phủ route theo routes.json"
  else fail_ "check-routes chưa đủ 100% (đợt d, e: xem mục 'Chờ trước khi bật' trong runbook)"; fi
  if [ -f "$OWNERSHIP_FILE" ] && [ -n "$prevmau" ] && [ -f "$prevmau" ]; then
    if cmp -s "$OWNERSHIP_FILE" "$prevmau"; then ok_ "tệp đang chạy trùng mẫu đợt $prev"
    else echo "  [LƯU Ý] tệp đang chạy khác mẫu đợt $prev (chỉ chấp nhận chỗ khác có lý do): diff $OWNERSHIP_FILE $prevmau"; fi
  fi

  echo "2. Shadow: route safe_for_shadow của đợt đạt min_samples, khác biệt = 0"
  tmp=$(mktemp)
  wave_routes "$mau" "$prevmau" > "$tmp"
  local n; n=$(grep -c . "$tmp" || true)
  if [ "$n" = 0 ]; then ok_ "đợt không có route safe_for_shadow nào mới (không cần mẫu)"
  elif [ ! -f "$SHADOW_REPORT_FILE" ]; then
    fail_ "không có báo cáo shadow $SHADOW_REPORT_FILE ($n route cần mẫu; bật SHADOW_SAMPLE_RATE, hybrid.md mục 6b)"
  else
    shadow_check "$tmp" > "$tmp.out" || true
    local win need_h
    read -r _ win need_h < <(grep '^CUASO' "$tmp.out")
    if [ "$(awk -v w="$win" -v h="$need_h" 'BEGIN{print (w>=h)?1:0}')" = 1 ]; then ok_ "cửa sổ shadow ${win} giờ (cần ${need_h})"
    else fail_ "cửa sổ shadow mới ${win} giờ, cần ${need_h} (đếm lại từ 0 mỗi lần serve khởi động lại)"; fi
    grep -q '^CU ' "$tmp.out" && fail_ "$(grep '^CU ' "$tmp.out" | head -1 | cut -c4-)"
    local tong; tong=$(grep '^TONG' "$tmp.out")
    set -- $tong; local total=$2 good=$3 miss=$4 bad=$5
    if [ "$bad" = 0 ]; then ok_ "không route nào khác biệt hoặc không shadow được"; else fail_ "$bad route khác biệt / không shadow được:"; grep -E '^(KHAC|KHONG) ' "$tmp.out" | sed 's/^[A-Z]* /      /'; fi
    if [ "$miss" = 0 ]; then ok_ "mọi route ($good/$total) đủ mẫu"
    else
      fail_ "$miss/$total route thiếu mẫu, cần quét bù bằng X13 (GET theo id lấy từ DB trên bản sao dữ liệu thật):"
      grep '^THIEU ' "$tmp.out" | sed 's/^THIEU /      /'
    fi
  fi

  echo "3. Bản dump gần nhất (toàn bộ DB, ngay trước khi bật)"
  check_dump

  echo "4. Bộ kiểm bất biến X11"
  if "$TRINITY_BIN" check-invariants --state "$INVARIANT_STATE" >/dev/null 2>&1; then ok_ "check-invariants xanh"
  else fail_ "check-invariants đỏ hoặc không chạy được (chạy lại tay: $TRINITY_BIN check-invariants --state $INVARIANT_STATE)"; fi

  echo "5. Việc người làm, script không đo được"
  echo "  [NHẮC] đợt trước đã qua 72 giờ đầu; công ty thử chạy 24 giờ cho module có ghi; chụp storage/uploads; người duyệt (đợt d: mẫu phiếu lương, 4 tệp chấm công)"
  echo "  [NHẮC] đợt d, e chuyển job: chỉ khi job đã đăng ký ở scheduler của serve và stale-work.digest qua kiểm mục 5 của cutover.md"

  rm -f "$tmp" "$tmp.out"
  echo
  if [ "$FAILS" = 0 ]; then echo "KẾT LUẬN: đủ điều kiện máy đo được cho đợt $dot."; return 0; fi
  echo "KẾT LUẬN: CHƯA ĐỦ ($FAILS mục). Không bật đợt $dot."; return 1
}

check_dump() {
  local newest age_h
  newest=$(ls -1dt "$BACKUP_DIR"/cutover-*/db.dump 2>/dev/null | head -1 || true)
  if [ -z "$newest" ]; then fail_ "không có $BACKUP_DIR/cutover-<ts>/db.dump (làm theo cutover.md mục 2)"; return; fi
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest") ) / 3600 ))
  if [ "$age_h" -le "$MAX_DUMP_AGE_HOURS" ]; then ok_ "$newest cách đây ${age_h} giờ (tối đa $MAX_DUMP_AGE_HOURS)"
  else fail_ "$newest đã ${age_h} giờ tuổi (tối đa $MAX_DUMP_AGE_HOURS): dump lại ngay trước khi bật"; fi
  [ -s "$newest" ] || { fail_ "bản dump rỗng"; return; }
  local sumf="$newest.sha256" dir; dir=$(dirname "$newest")
  if [ -f "$sumf" ]; then
    if (cd "$dir" && { sha256sum -c db.dump.sha256 >/dev/null 2>&1 || shasum -a 256 -c db.dump.sha256 >/dev/null 2>&1; }); then ok_ "sha256 khớp"
    else fail_ "sha256 không khớp"; fi
  else fail_ "thiếu db.dump.sha256"; fi
  if command -v pg_restore >/dev/null 2>&1; then
    if pg_restore -l "$newest" >/dev/null 2>&1; then ok_ "pg_restore -l đọc được"; else fail_ "pg_restore -l không đọc được bản dump"; fi
  else echo "  [LƯU Ý] không có pg_restore trên máy này, chưa kiểm đọc được bản dump"; fi
}

reload() { # $1 -n|""  $2 khong-hup|""
  [ "$2" = khong-hup ] && { echo "bỏ qua nạp lại (--khong-hup): nhớ gửi SIGHUP tay"; return 0; }
  if [ -n "$RELOAD_CMD" ]; then bash -c "$RELOAD_CMD"
  else
    local pid; pid=$(pidof trinity 2>/dev/null || true)
    [ -n "$pid" ] || die "không thấy tiến trình trinity để gửi SIGHUP (đặt RELOAD_CMD hoặc dùng --khong-hup); tệp ĐÃ đổi" 1
    kill -HUP $pid
  fi
  echo "đã gửi SIGHUP"
}

# Thay tệp sở hữu từ một nguồn: ghi .new cùng thư mục, check-config, rồi mv -f.
swap_in() { # $1 nguồn
  local src=$1 new="$OWNERSHIP_FILE.new"
  cp "$src" "$new"
  if ! TRINITY_OWNERSHIP_FILE="$new" "$TRINITY_BIN" check-config >/dev/null 2>&1; then
    rm -f "$new"; die "check-config không nạp được $src; chưa đổi gì" 1
  fi
  mv -f "$new" "$OWNERSHIP_FILE"
}

bat() {
  local dot=$1 dry=$2 hup=$3 mau ts dir
  mau=$(mau_of "$dot")
  [ -f "$mau" ] || die "không có mẫu $mau"
  [ -f "$OWNERSHIP_FILE" ] || die "không có tệp sở hữu đang chạy $OWNERSHIP_FILE"
  kiem_truoc "$dot" || die "chưa đủ điều kiện, không bật" 1
  ts=$(date +%Y%m%d-%H%M%S); dir="$BACKUP_DIR/cutover-$ts"
  echo "== bật đợt $dot =="
  if [ "$dry" = 1 ]; then
    echo "(-n) sẽ: sao lưu $OWNERSHIP_FILE -> $dir/ownership.before.json; thay bằng $mau; check-config; mv; SIGHUP"
    return 0
  fi
  mkdir -p "$dir"
  cp "$OWNERSHIP_FILE" "$dir/ownership.before.json"
  cmp -s "$OWNERSHIP_FILE" "$dir/ownership.before.json" || die "sao lưu tệp sở hữu không khớp" 1
  echo "$dir/ownership.before.json" > "$(pointer_of "$dot")"
  echo "đã sao lưu tệp sở hữu: $dir/ownership.before.json"
  swap_in "$mau"
  echo "đã ghép mẫu đợt $dot vào $OWNERSHIP_FILE"
  reload "$dry" "$hup"
  cat <<TXT
Việc kế (runbook cutover-cac-dot.md, mục đợt $dot):
  - kiểm sau khi bật trong 10 phút đầu bằng các lệnh curl của runbook; log Rust không có lỗi nạp tệp sở hữu
  - $TRINITY_BIN check-invariants --state $INVARIANT_STATE ngay bây giờ, rồi cron MỖI GIỜ trong 72 giờ (docs/rust/invariants.md)
  - lui: $0 lui $dot
TXT
}

lui() {
  local dot=$1 dry=$2 hup=$3 from=$4 def=$5 ptr src
  [ -f "$OWNERSHIP_FILE" ] || die "không có tệp sở hữu đang chạy $OWNERSHIP_FILE"
  ptr=$(pointer_of "$dot")
  if [ -n "$from" ]; then src=$from
  elif [ -f "$ptr" ]; then src=$(cat "$ptr")
  elif [ "$def" = 1 ]; then
    src=$(mktemp); printf '{\n  "routes": [],\n  "jobs": {},\n  "migrate": "node",\n  "web": "rust"\n}\n' > "$src"
  else die "không có bản sao lưu trước đợt $dot ($ptr); dùng --tu <tệp> hoặc --ve-mac-dinh (mọi thứ về Node)"; fi
  [ -f "$src" ] || die "không có tệp khôi phục $src"
  echo "== lui đợt $dot: khôi phục từ $src =="
  if [ "$dry" = 1 ]; then echo "(-n) sẽ: lưu tệp hiện tại; thay bằng $src; check-config; mv; SIGHUP"; return 0; fi
  mkdir -p "$BACKUP_DIR"
  cp "$OWNERSHIP_FILE" "$BACKUP_DIR/ownership.sau-bat-dot-$dot.$(date +%Y%m%d-%H%M%S).json"
  swap_in "$src"
  echo "đã khôi phục tệp sở hữu"
  reload "$dry" "$hup"
  cat <<TXT
Việc kế: ca smoke trên Node; $TRINITY_BIN check-invariants; ghi lý do lui vào issue của đợt.
Đợt d: kiểm lại stale-work.digest (cutover.md mục 5) trước khi coi là xong. Không khôi phục dump đè DB (cutover.md mục 6).
TXT
}

[ $# -ge 2 ] || usage
CMD=$1; DOT=$2; shift 2
valid_dot "$DOT" || die "đợt phải là a, b, c, d hoặc e (nhận: $DOT)"
DRY=0; HUP=""; FROM=""; DEF=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--thu) DRY=1;;
    --khong-hup) HUP=khong-hup;;
    --ve-mac-dinh) DEF=1;;
    --tu) FROM="${2:?--tu cần đường dẫn}"; shift;;
    *) die "tham số lạ: $1";;
  esac; shift
done
case "$CMD" in
  kiem-truoc) kiem_truoc "$DOT";;
  bat) bat "$DOT" "$DRY" "$HUP";;
  lui) lui "$DOT" "$DRY" "$HUP" "$FROM" "$DEF";;
  *) usage;;
esac
