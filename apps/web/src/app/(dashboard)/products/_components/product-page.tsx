"use client"

/**
 * Trang một sản phẩm (`/products/[id]`): tìm sản phẩm trong danh sách đã tải (`GET /products`) rồi chọn BỐ CỤC theo khổ —
 * ≥1024px trang sửa hai cột, dưới đó màn xem + sửa nhanh. Hai bố cục KHÁC nhau nên chỉ dựng một cái một lúc.
 */
import { useSyncExternalStore } from "react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { useProducts } from "@/hooks/products/use-products"
import { useRouteParams } from "@/lib/route-params"
import { usePermissions } from "@/lib/rbac"
import { ProductEditorDesktop } from "./product-editor-desktop"
import { ProductMobile } from "./product-mobile"

const QUERY = "(min-width: 1024px)"

/** `undefined` trước khi biết khổ màn (lần vẽ đầu) để không nhấp nháy sai bố cục. */
function useIsDesktop(): boolean | undefined {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(QUERY)
      m.addEventListener("change", cb)
      return () => m.removeEventListener("change", cb)
    },
    () => window.matchMedia(QUERY).matches,
    () => undefined,
  )
}

export function ProductPage() {
  const params = useRouteParams<"id">("/products/:id")
  const { can } = usePermissions()
  const canManage = can("products.manage")
  const { data: products = [], isLoading, isError, error, refetch, isFetching } = useProducts()
  const isDesktop = useIsDesktop()

  const id = params ? Number(params.id) : null
  const product = id != null ? products.find((p) => p.id === id) : undefined

  if (!params || isLoading || isDesktop === undefined) return <LoadingBlock variant="cards" count={2} label="Đang tải sản phẩm…" />
  if (isError && products.length === 0) {
    return <ErrorState title="Không tải được sản phẩm" error={error} onRetry={() => void refetch()} retrying={isFetching} />
  }
  if (!product) {
    return (
      <EmptyState
        variant="ax"
        title="Không tìm thấy sản phẩm"
        message="Sản phẩm có thể đã bị xoá hoặc bạn không có quyền xem."
        action={
          <Button variant="ax-secondary" size="ax" render={<Link href="/products" />}>
            Về danh sách sản phẩm
          </Button>
        }
      />
    )
  }
  // `key` theo id: đổi sang sản phẩm khác thì dựng lại bản nháp.
  return isDesktop ? (
    <ProductEditorDesktop key={product.id} product={product} canManage={canManage} />
  ) : (
    <ProductMobile key={product.id} product={product} canManage={canManage} />
  )
}
