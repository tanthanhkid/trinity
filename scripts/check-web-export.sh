#!/usr/bin/env bash
# Kiểm thư mục bản xuất tĩnh của web (`next build` output: 'export' → apps/web/out) trước khi nhúng vào binary Rust.
# Dùng: check-web-export.sh [thư-mục, mặc định apps/web/out]
set -euo pipefail

dir="${1:-apps/web/out}"

[ -d "$dir" ] || { echo "không thấy $dir: chạy 'pnpm --filter ./apps/web build:export' trước" >&2; exit 1; }
[ -f "$dir/index.html" ] || { echo "$dir thiếu index.html" >&2; exit 1; }
ls "$dir"/_next/static >/dev/null 2>&1 || { echo "$dir thiếu _next/static" >&2; exit 1; }

files=$(find "$dir" -type f | wc -l | tr -d ' ')
size=$(du -sk "$dir" | cut -f1)
echo "Bản xuất web: ${files} tệp, ${size} KB"
