#!/usr/bin/env bash
# Kiểm binary phát hành có nhúng web (PLAN mục 5, 10): in kích thước, đỏ khi >= giới hạn.
# Dùng: check-binary-size.sh <đường-dẫn-binary> [giới-hạn-MB, mặc định 80]
set -euo pipefail

bin="${1:?thiếu đường dẫn binary}"
limit_mb="${2:-80}"

[ -f "$bin" ] || { echo "không thấy binary: $bin" >&2; exit 1; }

# `wc -c` chạy giống nhau trên Linux và macOS (stat thì khác cờ).
bytes=$(wc -c < "$bin" | tr -d ' ')
mb=$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')
echo "Kích thước $(basename "$bin"): ${bytes} byte (${mb} MB), giới hạn ${limit_mb} MB"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '| %s | %s MB | giới hạn %s MB |\n' "$(basename "$bin")" "$mb" "$limit_mb" >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$bytes" -ge $((limit_mb * 1048576)) ]; then
  echo "Binary vượt ${limit_mb} MB" >&2
  exit 1
fi
