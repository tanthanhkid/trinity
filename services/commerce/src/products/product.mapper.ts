import { Prisma } from '@trinity/prisma';

/**
 * Shape trả FE. `BigInt` KHÔNG JSON-serialize được nên phải đổi tại đây:
 *  - `BigInt`  (price) → number. `JSON.stringify(BigInt)` ném
 *    TypeError, và Commerce service KHÔNG có global BigInt serializer. An toàn vì
 *    DTO chặn `<= 1e12`, dưới `Number.MAX_SAFE_INTEGER` (9,007e15).
 *
 * ⚠️ `price` `null` giữ NGUYÊN, KHÔNG coalesce về 0: "chưa nhập giá" khác "giá 0".
 * FE hiện "—" khi `== null`.
 *
 * Khung khai báo chung đa ngành: `project_id` OPTIONAL;
 * `category_id`/`attributes`/`description`/`price`.
 */
export interface ProductDto {
  id: number;
  code: string;
  name: string;
  project_id: number | null;
  brand: string | null;
  color: string | null;
  tags: string[];
  is_featured: boolean;
  image_url: string | null;
  /** Danh mục/ngành sản phẩm — `null` = chưa phân loại. */
  category_id: number | null;
  /** Giá trị thuộc tính động theo `ProductAttributeDef` của `category_id`. */
  attributes: Record<string, unknown>;
  /** Mô tả tự do — khung chung mọi ngành. */
  description: string | null;
  /** Giá bán VND — khung chung mọi ngành, khung chung mọi ngành. */
  price: number | null;
  is_active: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** `select` tường minh — KHÔNG `include`, KHÔNG `SELECT *` (coding-standards). */
export const PRODUCT_SELECT = {
  id: true,
  code: true,
  name: true,
  project_id: true,
  brand: true,
  color: true,
  tags: true,
  is_featured: true,
  image_url: true,
  category_id: true,
  attributes: true,
  description: true,
  price: true,
  is_active: true,
  created_by: true,
  created_at: true,
  updated_at: true,
} as const;

/** Row đúng shape `PRODUCT_SELECT` — khai tường minh để không phụ thuộc type generate. */
export interface ProductRow {
  id: number;
  code: string;
  name: string;
  project_id: number | null;
  brand: string | null;
  color: string | null;
  tags: string[];
  is_featured: boolean;
  image_url: string | null;
  category_id: number | null;
  attributes: Prisma.JsonValue;
  description: string | null;
  price: bigint | null;
  is_active: boolean;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

export function toProductDto(p: ProductRow): ProductDto {
  return {
    ...p,
    price: p.price != null ? Number(p.price) : null,
    attributes: isPlainAttributes(p.attributes) ? p.attributes : {},
  };
}

/** `attributes` DB default `'{}'::jsonb` — mọi row PHẢI là object phẳng, không mảng/scalar. */
function isPlainAttributes(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
