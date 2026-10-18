#!/usr/bin/env bash
# Hàng rào SQL viết tay (spike RLS). RLS ở DB chặn rò dữ liệu giữa khách thuê cho cả SQL viết tay; script này chặn
# phần RLS không chặn được: SQL nối chuỗi (injection) và bỏ qua tham số hoá.
#   1. Cấm `$queryRawUnsafe` / `$executeRawUnsafe` trong mã chạy thật (test được phép: dọn bảng).
#   2. `Prisma.raw(` chỉ ở các file đã duyệt — mỗi chỗ chèn tên cột/bảng cố định, không chèn dữ liệu người dùng.
set -euo pipefail
cd "$(dirname "$0")/../.."

ALLOW_PRISMA_RAW=(
  services/crm/src/attendance/attendance.service.ts
  services/crm/src/custom-objects/refs/record-refs.service.ts
)

src_files() {
  git ls-files 'services/**/*.ts' 'apps/**/*.ts' 'packages/**/*.ts' \
    | grep -vE '(\.spec\.ts|\.e2e-spec\.ts|/__tests__/|/test/|/__pg__/)'
}

fail=0
unsafe=$(src_files | xargs grep -nE '\$(queryRawUnsafe|executeRawUnsafe)\b' || true)
if [ -n "$unsafe" ]; then
  echo "::error::Cấm \$queryRawUnsafe/\$executeRawUnsafe — dùng \$queryRaw\`...\` hoặc Prisma.sql (tham số hoá):"
  echo "$unsafe"
  fail=1
fi

raw=$(src_files | xargs grep -lE 'Prisma\.raw\(' || true)
for f in $raw; do
  ok=0
  for a in "${ALLOW_PRISMA_RAW[@]}"; do [ "$f" = "$a" ] && ok=1; done
  if [ "$ok" = 0 ]; then
    echo "::error file=$f::Prisma.raw( mới — chỉ dùng cho tên cột/bảng cố định; thêm vào ALLOW_PRISMA_RAW sau khi review"
    fail=1
  fi
done

total=$(src_files | xargs grep -cE '\$(queryRaw|executeRaw)\b' | awk -F: '{s+=$2} END {print s+0}')
echo "SQL viết tay (\$queryRaw/\$executeRaw) trong mã chạy thật: $total chỗ; Unsafe: 0 được phép; Prisma.raw: ${#ALLOW_PRISMA_RAW[@]} file đã duyệt."
exit $fail
