#!/usr/bin/env bash
# Kiểm kê dữ liệu của các kết nối sắp gỡ (R002) — CHỈ ĐỌC.
#
#   DATABASE_URL=postgresql://reader@host/db scripts/ops/kiem-ke-ket-noi.sh            # mọi công ty
#   DATABASE_URL=... scripts/ops/kiem-ke-ket-noi.sh --company 1                         # một công ty
#
# Env: DATABASE_URL (bắt buộc), KEEP_NETWORKS (mặc định "facebook,zalo": mạng còn giữ; mạng khác đánh dấu GỠ).
# Chỉ phát SELECT, mọi phiên đặt `default_transaction_read_only = on` — dùng vai trò DB chỉ đọc để chắc chắn tuyệt đối.
# Mã thoát: 0 = xong; 2 = thiếu cấu hình / không nối được. Không in token, tên khách hay nội dung (chỉ số đếm).
set -euo pipefail

: "${DATABASE_URL:?Thiếu DATABASE_URL}"
KEEP="${KEEP_NETWORKS:-facebook,zalo}"
ONLY=""
[ "${1:-}" = "--company" ] && ONLY="${2:?--company cần id}"
case "$ONLY" in ''|*[!0-9]*) [ -n "$ONLY" ] && { echo "id công ty phải là số" >&2; exit 2; } ;; esac

export PGOPTIONS="-c default_transaction_read_only=on"
q() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
command -v psql >/dev/null || { echo "Cần psql" >&2; exit 2; }

q -Atc "select 1" >/dev/null || { echo "Không nối được DB" >&2; exit 2; }
HAS_PLATFORM=$(q -Atc "select to_regclass('platform.companies') is not null")
if [ "$HAS_PLATFORM" = t ]; then
  COMPANIES=$(q -AtF '|' -c "select id, schema_name from platform.companies ${ONLY:+where id = $ONLY} order by id")
else
  [ -z "$ONLY" ] || [ "$ONLY" = 1 ] || { echo "Bản một công ty: chỉ có công ty 1" >&2; exit 2; }
  COMPANIES="1|public"
fi
[ -n "$COMPANIES" ] || { echo "Không có công ty nào khớp" >&2; exit 2; }

ARCHIVE="google_connections google_sheet_syncs google_sheet_sync_runs extensions extension_versions extension_runs connector_accounts connector_events connector_records payment_intents"
KEEP_SQL=$(printf "'%s'," ${KEEP//,/ }); KEEP_SQL="${KEEP_SQL%,}"

while IFS='|' read -r CID SCH; do
  [[ "$SCH" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Tên schema lạ, bỏ qua: công ty $CID" >&2; continue; }
  HAVE=" $(q -At -c "select string_agg(table_name,' ') from information_schema.tables where table_schema='$SCH'") "
  has() { [[ "$HAVE" == *" $1 "* ]]; }
  S="\"$SCH\""
  U=()
  add() { U+=("$1"); }

  for t in $ARCHIVE; do
    has "$t" && add "select '1. bảng lưu trữ' sec, '$t' item, count(*)::text n from $S.$t"
  done
  if has social_accounts; then
    add "select '2. social_accounts theo mạng', network||' ['||status||']'||case when network in ($KEEP_SQL) then '' else ' GỠ' end, count(*)::text from $S.social_accounts group by network, status"
  fi
  if has social_post_targets; then
    add "select '3. social_post_targets theo mạng', network||' ['||status||']'||case when network in ($KEEP_SQL) then '' else ' GỠ' end, count(*)::text from $S.social_post_targets group by network, status"
  fi
  if has social_posts && has social_post_targets; then
    add "select '4. bài hẹn giờ còn hiệu lực (theo mạng)', t.network||case when t.network in ($KEEP_SQL) then '' else ' GỠ' end, count(distinct p.id)::text from $S.social_posts p join $S.social_post_targets t on t.post_id=p.id where p.status in ('scheduled','publishing') and t.status in ('queued','publishing','scheduled') group by t.network"
  fi
  if has social_recurrences && has social_accounts; then
    add "select '5. bài lặp còn hiệu lực (theo mạng)', a.network||case when a.network in ($KEEP_SQL) then '' else ' GỠ' end, count(distinct r.id)::text from $S.social_recurrences r cross join lateral jsonb_array_elements(coalesce(r.template->'targets','[]'::jsonb)) e join $S.social_accounts a on a.id = (e->>'account_id')::int where r.active and r.next_run_at is not null group by a.network"
  fi
  if has settings; then
    add "select '6. settings', k, (case when exists(select 1 from $S.settings where key=k) then 'có' else 'không' end) from unnest(array['online_store','org_features']) k"
    add "select '6. settings', 'org_features có khoá '||f, (case when exists(select 1 from $S.settings where key='org_features' and value like '%\"'||f||'\"%') then 'có' else 'không' end) from unnest(array['google_sheets','commerce_connectors','payments','extensions']) f"
  fi
  if has payment_intents; then
    add "select '7. payment_intents theo trạng thái', status||case when status='pending' and expires_at is not null and expires_at < now() then ' (hết hạn)' when status='pending' then ' (ĐANG CHỜ, chưa hết hạn)' else '' end, count(*)::text from $S.payment_intents group by 2"
  fi
  if has store_orders; then
    add "select '8. store_orders theo trạng thái', status, count(*)::text from $S.store_orders group by status"
  fi
  if [ "$HAS_PLATFORM" = t ]; then
    add "select '9. platform.company_routes theo loại' sec, kind item, count(*)::text n from platform.company_routes where company_id=$CID group by kind"
  fi

  echo; echo "=== Công ty $CID (schema $SCH) ==="
  if [ ${#U[@]} -eq 0 ]; then echo "(schema chưa có bảng nào cần kiểm kê)"; continue; fi
  SQL=$(printf '%s\nunion all\n' "${U[@]}"); SQL="select sec as \"nhóm\", item as \"mục\", n as \"số\" from (${SQL%union all*}) x(sec,item,n) order by 1,2"
  q -c "$SQL"
done <<< "$COMPANIES"
