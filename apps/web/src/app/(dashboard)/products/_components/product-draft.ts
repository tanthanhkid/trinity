/**
 * Bản nháp sửa sản phẩm dùng chung cho trang desktop và điện thoại («Ánh xanh»):
 * dựng từ `Product`, đổi ra payload `PATCH /products/:id`, đếm số thay đổi, kiểm lỗi.
 * `code` và `project_id` không có trong payload sửa (BE khoá) nên không nằm trong bản nháp.
 */
import type { Product, UpdateProductPayload } from "@/types/product"

export const DESCRIPTION_MAX = 2000
export const PRICE_MAX = 1_000_000_000_000

export interface ProductDraft {
  name: string
  /** Chỉ chữ số. */
  price: string
  category_id: string
  brand: string
  color: string
  tags: string[]
  description: string
  image_url: string
  is_featured: boolean
  is_active: boolean
  attributes: Record<string, unknown>
}

export function draftFromProduct(p: Product): ProductDraft {
  return {
    name: p.name,
    price: p.price != null ? String(Math.round(p.price)) : "",
    category_id: p.category_id != null ? String(p.category_id) : "",
    brand: p.brand ?? "",
    color: p.color ?? "",
    tags: [...p.tags],
    description: p.description ?? "",
    image_url: p.image_url ?? "",
    is_featured: p.is_featured,
    is_active: p.is_active,
    attributes: { ...p.attributes },
  }
}

export function draftToPayload(d: ProductDraft): UpdateProductPayload {
  return {
    name: d.name.trim(),
    price: d.price ? Number(d.price) : null,
    category_id: d.category_id ? Number(d.category_id) : null,
    brand: d.brand.trim() || null,
    color: d.color.trim() || null,
    tags: d.tags,
    description: d.description || null,
    image_url: d.image_url.trim() || null,
    is_featured: d.is_featured,
    is_active: d.is_active,
    attributes: d.attributes,
  }
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Các trường khác nhau giữa hai bản nháp. Đổi danh mục ⇒ kèm `attributes` (BE kiểm thuộc tính theo danh mục mới). */
export function changedFields(from: ProductDraft, to: ProductDraft): Partial<ProductDraft> {
  const out: Partial<ProductDraft> = {}
  for (const k of Object.keys(to) as (keyof ProductDraft)[]) {
    if (!sameValue(from[k], to[k])) (out as Record<string, unknown>)[k] = to[k]
  }
  if ("category_id" in out && !("attributes" in out)) out.attributes = to.attributes
  return out
}

const EMPTY_DRAFT: ProductDraft = {
  name: "", price: "", category_id: "", brand: "", color: "", tags: [], description: "", image_url: "",
  is_featured: false, is_active: true, attributes: {},
}

/** Chỉ lấy giá trị cũ của đúng các khoá trong `fields` (để Hoàn tác). */
export function pickFields(d: ProductDraft, fields: Partial<ProductDraft>): Partial<ProductDraft> {
  const out: Partial<ProductDraft> = {}
  for (const k of Object.keys(fields) as (keyof ProductDraft)[]) (out as Record<string, unknown>)[k] = d[k]
  return out
}

/**
 * Payload PATCH CHỈ gồm các trường trong `fields` — không gửi lại cả bản (tránh ghi đè sửa của người khác và tránh BE
 * kiểm lại danh mục/thuộc tính khi chỉ đổi giá, ảnh, ẩn/mở bán).
 */
export function fieldsToPayload(fields: Partial<ProductDraft>): UpdateProductPayload {
  const full = draftToPayload({ ...EMPTY_DRAFT, ...fields }) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(fields)) out[k] = full[k]
  return out as UpdateProductPayload
}

/** Áp `fields` vào bản nháp: trường nào bản nháp đã khác `expected` (người dùng gõ tiếp) thì giữ chữ đang gõ. */
export function mergeIntoDraft(d: ProductDraft, fields: Partial<ProductDraft>, expected: Partial<ProductDraft>): ProductDraft {
  const next = { ...d } as Record<string, unknown>
  for (const k of Object.keys(fields) as (keyof ProductDraft)[]) {
    if (sameValue(d[k], expected[k])) next[k] = fields[k]
  }
  return next as unknown as ProductDraft
}

/** Danh mục chọn được: đang hoạt động, cộng danh mục hiện tại của sản phẩm (dù đã ngưng) để còn hiện tên. */
export function usableCategories<T extends { id: number; is_active?: boolean }>(all: T[], currentId: string): T[] {
  return all.filter((c) => c.is_active !== false || String(c.id) === currentId)
}

const SCALAR_KEYS = [
  "name", "price", "category_id", "brand", "color", "description", "image_url", "is_featured", "is_active",
] as const

/** Số mục đã đổi so với bản đã lưu (thẻ + thuộc tính tính mỗi nhóm một mục). */
export function countChanges(a: ProductDraft, b: ProductDraft): number {
  let n = SCALAR_KEYS.filter((k) => a[k] !== b[k]).length
  if (a.tags.join("\u0001") !== b.tags.join("\u0001")) n += 1
  if (JSON.stringify(a.attributes) !== JSON.stringify(b.attributes)) n += 1
  return n
}

export interface DraftErrors {
  name?: string
  price?: string
  color?: string
  description?: string
}

export function validateDraft(d: ProductDraft): DraftErrors {
  const e: DraftErrors = {}
  if (d.name.trim().length < 2) e.name = "Tên sản phẩm tối thiểu 2 ký tự"
  else if (d.name.length > 255) e.name = "Tên sản phẩm tối đa 255 ký tự"
  if (d.price && Number(d.price) > PRICE_MAX) e.price = "Giá tối đa 1.000.000.000.000 ₫"
  if (d.color.length > 32) e.color = "Màu tối đa 32 ký tự"
  if (d.description.length > DESCRIPTION_MAX) e.description = "Mô tả tối đa 2000 ký tự"
  return e
}

export function hasErrors(e: DraftErrors): boolean {
  return Object.values(e).some(Boolean)
}

/** "1250000" → "1.250.000". */
export function groupDigits(d: string): string {
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
}

export function digitsOnly(v: string): string {
  return v.replace(/\D/g, "").slice(0, 13)
}

/** Danh sách "Sẵn sàng bán" của thiết kế — 4 điều kiện. */
export function readiness(d: ProductDraft): { label: string; ok: boolean }[] {
  return [
    { label: "Có ảnh", ok: d.image_url.trim() !== "" },
    { label: "Có giá bán", ok: d.price !== "" && d.price !== "0" },
    { label: "Đã chọn danh mục", ok: d.category_id !== "" },
    { label: "Có mô tả", ok: d.description.trim() !== "" },
  ]
}
