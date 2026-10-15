#!/usr/bin/env bash
# #377 — Đưa Nest (monolith) vào hàm Vercel bằng cơ chế CHÍNH THỨC của Next: package external nằm thật trong node_modules.
# Package workspace là symlink (realpath ngoài node_modules) ⇒ Turbopack cố đóng gói, `serverExternalPackages` vô hiệu, còn
# bản nối nft.json tay bị builder Vercel mới bỏ qua. Nên: `pnpm deploy` monolith (kèm @trinity/* + phụ thuộc prod) ra thư mục
# tự chứa, generate Prisma Client trong đó, rồi THAY symlink apps/web/node_modules/@trinity/monolith bằng thư mục thật.
# Chạy SAU `pnpm --filter @trinity/monolith build`, TRƯỚC `next build`. Chỉ dùng cho build serverless (Vercel).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)/nest-pkg"
TARGET="$ROOT/apps/web/node_modules/@trinity/monolith"

pnpm --dir "$ROOT" --filter @trinity/monolith deploy --prod --legacy "$OUT" >/dev/null
# Prisma Client đã generate ở repo (`pnpm db:generate`, cùng schema + binaryTargets) — chép `.prisma/client` sang đúng chỗ
# cạnh mỗi `@prisma/client` trong bản xuất (cùng tên thư mục store pnpm). Không chạy `prisma generate` trong bản xuất
# (CLI tự `npm i` khi không thấy package.json gốc).
copied=0
for src in "$ROOT"/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client; do
  [ -d "$src" ] || continue
  store="$(basename "$(dirname "$(dirname "$(dirname "$src")")")")"
  dst_parent="$OUT/node_modules/.pnpm/$store/node_modules"
  [ -d "$dst_parent/@prisma/client" ] || continue
  mkdir -p "$dst_parent/.prisma"
  rm -rf "$dst_parent/.prisma/client"
  cp -R "$src" "$dst_parent/.prisma/client"
  copied=$((copied + 1))
done
[ "$copied" -gt 0 ] || { echo "[prepare-nest-package] KHÔNG chép được .prisma/client (chưa chạy pnpm db:generate?)" >&2; exit 1; }

rm -rf "$TARGET"
mkdir -p "$(dirname "$TARGET")"
cp -R "$OUT" "$TARGET"
echo "[prepare-nest-package] @trinity/monolith → $(du -sh "$TARGET" | cut -f1) (thư mục thật, external cho Next)"
