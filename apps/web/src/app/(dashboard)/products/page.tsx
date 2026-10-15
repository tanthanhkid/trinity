"use client"

/**
 * Sản phẩm — CRUD sản phẩm theo quyền `products.view`/`products.manage`.
 */
import { PermissionGate } from "@/lib/rbac"
import { ProductsScreen } from "./_components/products-screen"

export default function ProductsPage() {
  return (
    <PermissionGate permission="products.view">
      <ProductsScreen />
    </PermissionGate>
  )
}
