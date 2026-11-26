/**
 * Thoát `\`, `%`, `_` để dùng giá trị làm vế phải của `ILIKE` như so sánh bằng không phân biệt hoa/thường.
 * Prisma `equals` + `mode: 'insensitive'` sinh `ILIKE $1` KHÔNG thoát, nên mã có `_` (hợp lệ trong mã sản phẩm/danh mục)
 * khớp nhầm mọi ký tự (`SP_1` trùng `SPX1`). Bản Rust so bằng `lower(code) = lower($1)`, cùng nghĩa với hàm này.
 */
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
