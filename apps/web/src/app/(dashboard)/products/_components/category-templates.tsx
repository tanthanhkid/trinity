"use client"

/**
 * "Tạo từ mẫu" — 2 khung sản phẩm gợi ý ("0 bắt buộc"), làm gọn qua nút bấm 1 lần thay vì bắt admin tự khai từng thuộc tính).
 * Nhấn nút gọi TUẦN TỰ `POST /product-categories` rồi N lần
 * `POST .../attribute-defs` — dùng lại NGUYÊN 2 hook CRUD sẵn có, KHÔNG thêm
 * endpoint BE mới.
 */
import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  useCreateAttributeDef,
  useCreateProductCategory,
} from "@/hooks/products/use-product-categories"
import type { CreateAttributeDefPayload, ProductCategory } from "@/types/product-category"

interface CategoryTemplate {
  code: string
  name: string
  description: string
  attributeDefs: CreateAttributeDefPayload[]
}

export const CATEGORY_TEMPLATES: CategoryTemplate[] = [
  {
    code: "retail",
    name: "Bán lẻ",
    description: "Sản phẩm hàng hoá bán lẻ.",
    attributeDefs: [
      { key: "warranty_months", label: "Bảo hành (tháng)", type: "number", is_required: false, sort_order: 0 },
      {
        key: "size",
        label: "Kích cỡ",
        type: "select",
        is_required: false,
        sort_order: 1,
        options: [
          { value: "s", label: "Nhỏ" },
          { value: "m", label: "Vừa" },
          { value: "l", label: "Lớn" },
        ],
      },
      { key: "stock_quantity", label: "Số lượng tồn kho", type: "number", is_required: false, sort_order: 2 },
    ],
  },
  {
    code: "service",
    name: "Dịch vụ",
    description: "Sản phẩm dịch vụ (không phải hàng hoá vật lý).",
    attributeDefs: [
      { key: "duration", label: "Thời lượng", type: "text", is_required: false, sort_order: 0 },
      { key: "location", label: "Địa điểm thực hiện", type: "text", is_required: false, sort_order: 1 },
      { key: "recurring", label: "Dịch vụ định kỳ", type: "boolean", is_required: false, sort_order: 2 },
    ],
  },
]

export function useCreateCategoryFromTemplate() {
  const createCategory = useCreateProductCategory()
  const createDef = useCreateAttributeDef()
  const queryClient = useQueryClient()
  const [isPending, setIsPending] = useState(false)

  async function createFromTemplate(
    template: CategoryTemplate,
    opts: { onSuccess: (created: ProductCategory) => void },
  ) {
    setIsPending(true)
    let created: ProductCategory | null = null
    try {
      created = await createCategory.mutateAsync({
        code: template.code,
        name: template.name,
        description: template.description,
      })
      for (const def of template.attributeDefs) {
        // TUẦN TỰ (không Promise.all) — `key` trùng trong CÙNG danh mục là lỗi
        // cấu hình mẫu, muốn thấy đúng def nào fail thay vì N lỗi chồng lên nhau.
        // eslint-disable-next-line no-await-in-loop
        await createDef.mutateAsync({ categoryId: created.id, payload: def })
      }
      queryClient.invalidateQueries({ queryKey: ["product-attribute-defs", created.id] })
      opts.onSuccess(created)
    } catch {
      // Không ném lại: caller gọi trong onClick không bắt lỗi (unhandled rejection). Danh mục có thể đã tạo xong
      // một phần — nói trung tính và làm mới danh sách để người dùng thấy trạng thái thật.
      toast.error(
        created
          ? `Đã tạo danh mục "${template.name}" nhưng chưa thêm đủ thuộc tính mẫu. Kiểm tra danh mục trong danh sách bên trái.`
          : `Tạo mẫu "${template.name}" chưa xong — có thể mã "${template.code}" đã tồn tại. Kiểm tra danh sách bên trái.`,
      )
      if (created) queryClient.invalidateQueries({ queryKey: ["product-attribute-defs", created.id] })
    } finally {
      setIsPending(false)
    }
  }

  return { createFromTemplate, isPending }
}
