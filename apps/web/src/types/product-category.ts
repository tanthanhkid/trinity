/**
 * Danh mục/ngành sản phẩm + định nghĩa thuộc tính động — mirror
 * `services/commerce/src/products/categories/` + `attribute-defs/` phía BE.
 */
export interface ProductCategory {
  id: number
  code: string
  name: string
  description: string | null
  is_active: boolean
  sort_order: number
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface CreateProductCategoryPayload {
  code: string
  name: string
  description?: string | null
  sort_order?: number
  is_active?: boolean
}

export type UpdateProductCategoryPayload = Partial<Omit<CreateProductCategoryPayload, "code">>

/** Whitelist kiểu thuộc tính — mirror `PRODUCT_ATTRIBUTE_TYPES` (BE validator). */
export const PRODUCT_ATTRIBUTE_TYPES = [
  "text",
  "number",
  "currency",
  "percent",
  "date",
  "select",
  "multiselect",
  "textarea",
  "boolean",
] as const

export type ProductAttributeType = (typeof PRODUCT_ATTRIBUTE_TYPES)[number]

export const PRODUCT_ATTRIBUTE_TYPE_LABELS: Record<ProductAttributeType, string> = {
  text: "Văn bản ngắn",
  textarea: "Văn bản dài",
  number: "Số",
  currency: "Tiền tệ (VNĐ)",
  percent: "Phần trăm (%)",
  date: "Ngày",
  boolean: "Đúng/Sai",
  select: "Chọn 1 (danh sách)",
  multiselect: "Chọn nhiều (danh sách)",
}

/** CẦN options (select/multiselect) — dùng để hiện ô cấu hình lựa chọn trong form quản trị. */
export function attributeTypeNeedsOptions(type: ProductAttributeType): boolean {
  return type === "select" || type === "multiselect"
}

export interface AttributeOption {
  value: string
  label: string
}

export interface ProductAttributeDef {
  id: number
  category_id: number
  key: string
  label: string
  type: ProductAttributeType
  options: AttributeOption[] | null
  is_required: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CreateAttributeDefPayload {
  key: string
  label: string
  type: ProductAttributeType
  options?: AttributeOption[]
  is_required?: boolean
  sort_order?: number
}

export type UpdateAttributeDefPayload = Partial<Omit<CreateAttributeDefPayload, "key">>
