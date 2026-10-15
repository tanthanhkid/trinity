/**
 * Danh mục sản phẩm — mirror 1:1 `services/commerce/src/products/product.mapper.ts`
 * (`ProductDto`) phía BE.
 *
 * Khung khai báo chung đa ngành: `project_id` OPTIONAL;
 * `category_id`/`attributes`/`description`/`price`. Thông tin theo ngành khai qua thuộc tính động.
 */
export interface Product {
  id: number
  code: string
  name: string
  project_id: number | null
  brand: string | null
  color: string | null
  tags: string[]
  is_featured: boolean
  image_url: string | null
  /** Danh mục/ngành sản phẩm — `null` = chưa phân loại. */
  category_id: number | null
  /** Giá trị thuộc tính động theo `ProductAttributeDef` của `category_id`. */
  attributes: Record<string, unknown>
  /** Mô tả tự do — khung chung mọi ngành. */
  description: string | null
  /** Giá bán VND — khung chung mọi ngành. */
  price: number | null
  is_active: boolean
  created_by: number | null
  created_at: string
  updated_at: string
}

/** Query của `GET /products` — mirror `ListProductsQueryDto`. */
export interface ListProductsParams {
  project_id?: number
  category_id?: number
  is_active?: boolean
  q?: string
}

/**
 * Payload tạo sản phẩm — mirror `CreateProductDto`. `code` BẮT BUỘC và KHÔNG
 * sửa được sau khi tạo. `project_id` nay OPTIONAL.
 */
export interface CreateProductPayload {
  code: string
  name: string
  project_id?: number | null
  category_id?: number | null
  attributes?: Record<string, unknown>
  description?: string | null
  price?: number | null
  brand?: string | null
  color?: string | null
  tags?: string[]
  is_featured?: boolean
  image_url?: string | null
}

/** Payload sửa sản phẩm — mirror `UpdateProductDto` (KHÔNG có `code`/`project_id`). */
export type UpdateProductPayload = Partial<Omit<CreateProductPayload, "code" | "project_id">> & {
  is_active?: boolean
}
