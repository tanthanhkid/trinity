"use client"

/**
 * Chi tiết / sửa một sản phẩm — giao diện «Ánh xanh»: desktop = trang sửa hai cột, điện thoại = xem + sửa nhanh.
 * Quyền xem `products.view`; sửa theo `products.manage` (không có ⇒ chỉ đọc).
 */
import { PermissionGate } from "@/lib/rbac"
import { ProductPage } from "../_components/product-page"

export default function ProductDetailPage() {
  return (
    <PermissionGate permission="products.view">
      <ProductPage />
    </PermissionGate>
  )
}
