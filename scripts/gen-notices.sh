#!/usr/bin/env bash
# Sinh danh sách giấy phép bên thứ ba (Rust: cargo-about) và SBOM CycloneDX (Rust: cargo-cyclonedx; web: pnpm sbom).
# Đầu ra mặc định: dist/notices/ (đã .gitignore nếu cần; workflow phát hành đính các tệp này vào GitHub Release).
# Cần: cargo install --locked cargo-about cargo-cyclonedx. Dùng: scripts/gen-notices.sh [thư-mục-ra]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist/notices}"
mkdir -p "$out"

cd "$root/server"
# --locked: dùng đúng Cargo.lock; giấy phép ngoài danh sách `accepted` của about.toml làm lệnh đỏ.
cargo about generate --locked -c about.toml about.hbs -o "$out/THIRD_PARTY_RUST.md"

# SBOM của binary `trinity`: cyclonedx ghi cạnh Cargo.toml của crate, rồi chuyển ra thư mục đầu ra.
(cd crates/trinity-bin && cargo cyclonedx --format json --spec-version 1.5 --override-filename trinity.cdx)
mv crates/trinity-bin/trinity.cdx.json "$out/sbom-trinity-rust.cdx.json"

# SBOM của phần web nhúng vào binary (lệnh pnpm sbom có từ pnpm 10.1x; bản ghim 10.6.5 chưa có nên hiện sẽ bỏ qua); không có thì bỏ qua, in cảnh báo thay vì đỏ.
cd "$root"
if pnpm sbom --help >/dev/null 2>&1; then
  pnpm sbom --sbom-format cyclonedx --prod > "$out/sbom-web.cdx.json"
else
  echo "cảnh báo: pnpm này chưa có lệnh 'sbom'; bỏ qua SBOM web" >&2
fi

echo "Đã ghi: $out"
ls -l "$out"
