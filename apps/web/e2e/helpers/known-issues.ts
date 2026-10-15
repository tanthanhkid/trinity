/**
 * Lỗi API ĐÃ BIẾT, đang có PR khác sửa. Test KHÔNG nuốt chúng (vẫn đỏ
 * cho tới khi bản sửa được deploy) — chỉ gắn nhãn để người đọc báo cáo phân biệt với
 * lỗi MỚI. Xoá mục khỏi danh sách này khi bản sửa đã được triển khai và test xanh.
 */
interface Known {
  /** Route đang mở (path, không query) mà lỗi xuất hiện — bỏ trống = mọi route. */
  onPath?: RegExp
  /** Khớp dòng `"<status> <METHOD> <url>"`. */
  line: RegExp
  note: string
}

const KNOWN: Known[] = [
  // Trống. Thêm mục ở đây khi có lỗi đang chờ PR sửa.
]

export const KNOWN_TAG = '[ĐÃ BIẾT, đang sửa]'

export function tagKnown(line: string, pathname: string): string {
  const hit = KNOWN.find((k) => (!k.onPath || k.onPath.test(pathname)) && k.line.test(line))
  return hit ? `${KNOWN_TAG} ${line}` : line
}

/**
 * LỖI SẢN PHẨM do bộ E2E phát hiện (khác `KNOWN` ở trên — lỗi API đang có PR sửa). Test liên quan VẪN ĐỎ
 * (không nới điều kiện cho xanh); thông điệp lỗi mang nhãn `[LỖI SẢN PHẨM <id>]` để báo cáo gom lại. Xoá mục
 * khi bản sửa đã được triển khai và test xanh. Bộ E2E KHÔNG sửa code sản phẩm.
 */
export interface ProductIssue {
  id: string
  severity: 'cao' | 'trung bình' | 'thấp'
  title: string
  evidence: string
  /** file:dòng nghi ngờ (lúc phát hiện). */
  suspect: string
}

export const PRODUCT_ISSUES: Record<string, ProductIssue> = {
  // Trống. Thêm mục khi e2e phát hiện lỗi sản phẩm mới.
}

export type ProductIssueId = string

export function issueTag(id: ProductIssueId): string {
  const i = PRODUCT_ISSUES[id]
  if (!i) return `[LỖI SẢN PHẨM ${id}]`
  return `[LỖI SẢN PHẨM ${i.id} · mức ${i.severity}] ${i.title}\n  Nghi ngờ: ${i.suspect}`
}
