import type { CustomFieldType } from "@/types/custom-objects"

/**
 * Siêu dữ liệu kiểu trường (nhãn, mô tả) + các tập kiểu — ĐỒNG BỘ TAY với
 * `services/crm/src/custom-objects/field-types.ts` (FE không import được code service).
 * BE là cổng thật: FE chỉ dùng để ẩn/hiện lựa chọn trong form cấu hình.
 */
export const FIELD_TYPE_META: Record<CustomFieldType, { label: string; hint: string }> = {
  text: { label: "Văn bản ngắn", hint: "Tên, mã, tiêu đề (tối đa 500 ký tự)" },
  long_text: { label: "Văn bản dài", hint: "Ghi chú, mô tả (tối đa 10.000 ký tự)" },
  number: { label: "Số", hint: "Số lượng, số lần, điểm đánh giá…" },
  currency: { label: "Tiền (VNĐ)", hint: "Số tiền nguyên, hiện dấu chấm hàng nghìn" },
  percent: { label: "Phần trăm", hint: "Ưu đãi, chiết khấu (nhập 5 = 5%)" },
  date: { label: "Ngày", hint: "Hiện dd/mm/yyyy" },
  datetime: { label: "Ngày giờ", hint: "Ngày kèm giờ theo giờ Việt Nam" },
  boolean: { label: "Có / Không", hint: "Ô tích" },
  select: { label: "Chọn một", hint: "Một giá trị trong danh sách bạn định nghĩa" },
  multi_select: { label: "Chọn nhiều", hint: "Nhiều giá trị trong danh sách" },
  email: { label: "Email", hint: "Kiểm tra định dạng" },
  phone: { label: "Số điện thoại", hint: "Số Việt Nam; che theo quyền xem SĐT đầy đủ" },
  url: { label: "Đường dẫn web", hint: "Chỉ http:// hoặc https://" },
  relation: { label: "Liên kết tới tính năng khác", hint: "Ví dụ: Khách hàng → Hợp đồng" },
  user: { label: "Nhân viên", hint: "Chọn một người dùng trong hệ thống" },
  formula: { label: "Công thức", hint: "Tự tính từ các trường số / tiền / % / ngày" },
  link: { label: "Liên kết (gắn thẻ @)", hint: "Gắn nhiều bản ghi ở BẤT KỲ bảng nào bằng mã (SP001) hoặc tên — không ràng buộc" },
}

export const FIELD_TYPE_ORDER: CustomFieldType[] = [
  "text", "long_text", "number", "currency", "percent", "date", "datetime", "boolean",
  "select", "multi_select", "email", "phone", "url", "relation", "user", "link", "formula",
]

export const TITLE_TYPES: readonly CustomFieldType[] = ["text", "number", "email", "date"]
export const UNIQUE_TYPES: readonly CustomFieldType[] = ["text", "number", "currency", "email", "phone", "url", "date", "datetime"]
export const FILTERABLE_TYPES: readonly CustomFieldType[] = ["select", "multi_select", "number", "currency", "percent", "date", "datetime", "boolean", "relation", "user"]
export const SORTABLE_TYPES: readonly CustomFieldType[] = ["text", "number", "currency", "percent", "date", "datetime", "select"]
export const FORMULA_REF_TYPES: readonly CustomFieldType[] = ["number", "currency", "percent", "date", "datetime"]

/** Màu nhãn lựa chọn → class badge (chỉ dùng token Tailwind có sẵn, KHÔNG màu nút). Có biến thể `dark:`. */
export const CHOICE_COLOR_CLASS: Record<string, string> = {
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  indigo: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  purple: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200",
}
export const CHOICE_COLORS = Object.keys(CHOICE_COLOR_CLASS)

export function customRecordsPath(key: string): string {
  return `/x/${key}`
}

/** Bảng màu tự gán cho lựa chọn CHƯA chọn màu — xoay vòng theo thứ tự lựa chọn (ổn định, không xám hết). */
export const CHOICE_AUTO_PALETTE = ["blue", "green", "amber", "purple", "teal", "pink", "indigo", "orange"] as const

/** Khoá màu hiệu lực của 1 lựa chọn: màu đã chọn → màu theo thứ tự trong danh sách → xám (giá trị không còn trong danh sách). */
export function resolveChoiceColor(choices: readonly { value: string; color?: string | null }[] | undefined, raw: string): string {
  const i = choices?.findIndex((c) => c.value === raw) ?? -1
  if (i < 0) return "gray"
  const own = choices?.[i]?.color
  if (own && CHOICE_COLOR_CLASS[own]) return own
  return CHOICE_AUTO_PALETTE[i % CHOICE_AUTO_PALETTE.length]
}
