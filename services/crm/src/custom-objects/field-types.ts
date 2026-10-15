/**
 * Thực thể tuỳ biến — hằng số + kiểu dùng chung BE. Nguồn DUY NHẤT của danh sách kiểu trường,
 * giới hạn và whitelist icon (FE có bản ánh xạ icon tương ứng ở `custom-object-icons.ts`).
 */

export const FIELD_TYPES = [
  'text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean',
  'select', 'multi_select', 'email', 'phone', 'url', 'relation', 'user', 'formula', 'link',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export function isFieldType(x: string): x is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(x)
}

/** Kiểu được phép làm TRƯỜNG TIÊU ĐỀ (cache vào `custom_records.title`): chuỗi ngắn, không cần ánh xạ nhãn, không phải SĐT. */
export const TITLE_TYPES: readonly FieldType[] = ['text', 'number', 'email', 'date']
/** Kiểu số học (đọc được trong công thức; `percent` quy về phân số: 5 → 0.05). */
export const NUMERIC_TYPES: readonly FieldType[] = ['number', 'currency', 'percent']
/** Kiểu ngày (chỉ làm đối số hàm ngày trong công thức). */
export const DATE_TYPES: readonly FieldType[] = ['date', 'datetime']
/** Kiểu được phép tham chiếu trong công thức. */
export const FORMULA_REF_TYPES: readonly FieldType[] = [...NUMERIC_TYPES, ...DATE_TYPES]
/** Kiểu cho phép LỌC theo giá trị. phone/long_text/url/email/text KHÔNG: tránh oracle dò SĐT và quét văn bản. */
export const FILTERABLE_TYPES: readonly FieldType[] = [
  'select', 'multi_select', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'relation', 'user',
]
/** Kiểu cho phép SẮP XẾP theo giá trị. */
export const SORTABLE_TYPES: readonly FieldType[] = [
  'text', 'number', 'currency', 'percent', 'date', 'datetime', 'select',
]
/** Đổi qua lại không mất ý nghĩa dữ liệu (khi trường ĐÃ có dữ liệu). */
export const COMPATIBLE_TYPE_GROUPS: readonly (readonly FieldType[])[] = [['text', 'long_text']]

export const LIMITS = {
  maxObjects: 50,
  maxFieldsPerObject: 60,
  maxChoices: 100,
  maxMultiValues: 50,
  maxRelationValues: 50,
  /** Trường "Liên kết": số thẻ tối đa / bản ghi. */
  maxLinkValues: 50,
  maxDataBytes: 32 * 1024,
  maxText: 500,
  maxLongText: 10_000,
  maxUrl: 2_000,
  maxTitle: 200,
  maxNumber: 1e15,
  maxCurrency: 1e13,
  maxListLimit: 100,
  defaultListLimit: 30,
  exportRowCap: 20_000,
  lookupLimit: 20,
  relatedPerGroup: 20,
  maxRelatedGroups: 20,
  maxFilterKeys: 10,
  maxFilterValues: 50,
  maxSampleRecords: 5,
} as const

/** Khoá URL/JSON: a-z0-9_ bắt đầu bằng chữ. */
export const KEY_REGEX = /^[a-z][a-z0-9_]{0,47}$/
/** Khoá không được dùng làm `key` thực thể (đụng đường dẫn tĩnh của API / FE). */
export const RESERVED_OBJECT_KEYS: readonly string[] = ['nav', 'templates', 'lookup', 'formula', 'new', 'export']

/** Tên icon lucide được phép (FE ánh xạ sang component). Giá trị lạ bị từ chối ở BE. */
export const CUSTOM_ICONS = [
  'shapes', 'users', 'user-round', 'graduation-cap', 'book-open', 'receipt', 'wallet', 'clipboard-list',
  'calendar-check', 'package', 'store', 'building-2', 'briefcase', 'heart-pulse', 'stethoscope', 'car',
  'home', 'wrench', 'truck', 'shopping-cart', 'file-text', 'folder', 'tag', 'star', 'map-pin', 'phone',
  'credit-card', 'banknote', 'baby', 'utensils', 'dumbbell', 'plane',
] as const
export type CustomIcon = (typeof CUSTOM_ICONS)[number]

export const CHOICE_COLORS = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const

export interface SelectChoice {
  value: string
  label: string
  color?: string
}

/** Cấu hình `options` theo kiểu (đã chuẩn hoá, an toàn để lưu). */
export interface FieldOptions {
  choices?: SelectChoice[]
  /** relation: trỏ tới thực thể tuỳ biến khác (id) HOẶC `contact`. */
  target_object_id?: number
  target?: 'contact'
  multiple?: boolean
  /** CHỈ có trong phản hồi định nghĩa (suy ra từ `target_object_id`, KHÔNG lưu): khoá + tên số nhiều của thực thể đích nếu người xem thấy được. */
  target_key?: string
  target_label?: string
  expression?: string
  /** formula: cách hiển thị kết quả. */
  format?: 'number' | 'currency' | 'percent'
  decimals?: number
}

export type RecordData = Record<string, unknown>

export interface FieldDef {
  id: number
  key: string
  label: string
  type: FieldType
  required: boolean
  is_unique: boolean
  is_title: boolean
  show_in_list: boolean
  sort_order: number
  options: FieldOptions
  help_text: string | null
}
