"use client"

/**
 * Màn "Sản phẩm" (tổng quát hoá đa ngành) — chỉ giữ phần có nguồn dữ liệu thật từ BE.
 *
 *  - GIỮ: lưới sản phẩm + danh mục/mô tả/giá, tìm kiếm, lọc theo dự
 *    án/danh mục/trạng thái, CRUD theo quyền `products.view`/`products.manage`.
 *  - MỚI: dropdown lọc theo Danh mục + nút "Quản lý danh mục" mở
 *    `ProductCategoryManagerDialog` (CRUD danh mục + thuộc tính động).
 *  - Không dựng các thao tác chưa có BE hỗ trợ (tránh affordance giả).
 */
import { useMemo, useState } from "react"
import { Package, Plus, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { toastWithUndo } from "@/lib/undo"
import { Button } from "@/components/ui/button"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { usePermissions } from "@/lib/rbac"
import { useActiveProjects } from "@/hooks/use-projects"
import axios from "axios"
import { getApiErrorMessage } from "@/lib/api-client"
import { useDeleteProduct, useProducts, useUpdateProduct } from "@/hooks/products/use-products"
import { useProductCategories } from "@/hooks/products/use-product-categories"
import type { Product } from "@/types/product"
import { ProductCard } from "./product-card"
import { ProductFormDialog } from "./product-form-dialog"
import { ProductDetailModal } from "./product-detail-modal"
import { ProductCategoryManagerDialog } from "./product-category-manager-dialog"
import { ProductDeleteDialog } from "./product-delete-dialog"
import { ALL_SENTINEL, ProductsFilterBar } from "./products-filter-bar"

export function ProductsScreen() {
  const { can } = usePermissions()
  const canManage = can("products.manage")
  const { data: products = [], isLoading, isError, error, refetch, isFetching } = useProducts()
  const { data: projects = [] } = useActiveProjects()
  const { data: categories = [] } = useProductCategories(true)

  const [search, setSearch] = useState("")
  const [projectFilter, setProjectFilter] = useState<string>(ALL_SENTINEL)
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_SENTINEL)
  const [showInactive, setShowInactive] = useState(false)

  const [detailProduct, setDetailProduct] = useState<Product | null>(null)
  const [editProduct, setEditProduct] = useState<Product | undefined>(undefined)
  const [showCreate, setShowCreate] = useState(false)
  const [showCategoryManager, setShowCategoryManager] = useState(false)
  const [deleteProduct, setDeleteProduct] = useState<Product | null>(null)
  const [deleteError, setDeleteError] = useState<{ message: string; conflict: boolean } | null>(null)

  const updateMutation = useUpdateProduct()
  const deleteMutation = useDeleteProduct()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((p) => {
      if (!showInactive && !p.is_active) return false
      if (projectFilter !== ALL_SENTINEL && String(p.project_id) !== projectFilter) return false
      if (categoryFilter !== ALL_SENTINEL && String(p.category_id) !== categoryFilter) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.brand ?? "").toLowerCase().includes(q)
      )
    })
  }, [products, search, projectFilter, categoryFilter, showInactive])

  function closeDelete() {
    setDeleteProduct(null)
    setDeleteError(null)
  }

  function handleDelete(product: Product) {
    setDeleteError(null)
    deleteMutation.mutate(product.id, {
      onSuccess: () => {
        closeDelete()
        toast.success(`Đã xoá sản phẩm “${product.name}”`)
      },
      onError: (err) =>
        setDeleteError({
          message: getApiErrorMessage(err, "Không xoá được sản phẩm, thử lại sau"),
          conflict: axios.isAxiosError(err) && err.response?.status === 409,
        }),
    })
  }

  function handleHideFromDialog(product: Product) {
    setActive(product, false, closeDelete)
  }

  /** Ẩn / mở bán lại — đảo được bằng chính API này nên có "Hoàn tác"; lỗi thì nói rõ (trước đây im lặng). */
  function setActive(product: Product, active: boolean, done?: () => void) {
    updateMutation.mutate(
      { id: product.id, payload: { is_active: active } },
      {
        onSuccess: () => {
          done?.()
          toastWithUndo({
            message: active ? `Đã mở bán lại “${product.name}”` : `Đã ẩn “${product.name}” — ngừng bán`,
            onUndo: () =>
              updateMutation.mutate(
                { id: product.id, payload: { is_active: !active } },
                { onError: (err) => toast.error(getApiErrorMessage(err, "Chưa hoàn tác được")) },
              ),
          })
        },
        onError: (err) => toast.error(getApiErrorMessage(err, active ? "Chưa mở bán lại được" : "Chưa ẩn được sản phẩm")),
      },
    )
  }

  function clearFilters() {
    setSearch("")
    setProjectFilter(ALL_SENTINEL)
    setCategoryFilter(ALL_SENTINEL)
    setShowInactive(false)
  }

  function handleToggleActive(product: Product) {
    setActive(product, !product.is_active)
  }

  return (
    <div className="space-y-4">
      <ShellPageHeader
        title="Sản phẩm"
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setShowCategoryManager(true)}>
                <Settings2 className="mr-1.5 size-4" /> Quản lý danh mục
              </Button>
              <Button className={MOBILE_FAB_CLASS} onClick={() => setShowCreate(true)}>
                <Plus className="mr-1.5 size-4" /> Thêm sản phẩm
              </Button>
            </>
          )
        }
      />

      <ProductsFilterBar
        search={search}
        onSearchChange={setSearch}
        categoryFilter={categoryFilter}
        onCategoryChange={setCategoryFilter}
        projectFilter={projectFilter}
        onProjectChange={setProjectFilter}
        showInactive={showInactive}
        onShowInactiveChange={setShowInactive}
        categories={categories}
        projects={projects}
        total={filtered.length}
      />

      {isLoading ? (
        <LoadingBlock variant="cards" count={4} label="Đang tải sản phẩm…" />
      ) : isError && products.length === 0 ? (
        // Lỗi tải ≠ chưa có sản phẩm.
        <ErrorState title="Không tải được danh sách sản phẩm" error={error} onRetry={() => void refetch()} retrying={isFetching} />
      ) : products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Chưa có sản phẩm nào"
          message="Thêm sản phẩm để bán ở POS, trang bán hàng và gắn vào cơ hội."
          action={canManage ? (
            <Button variant="outline" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 size-4" /> Thêm sản phẩm
            </Button>
          ) : undefined}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Không có sản phẩm nào khớp bộ lọc"
          message="Thử bỏ bớt điều kiện hoặc tìm bằng tên khác."
          action={<Button variant="outline" onClick={clearFilters}>Xoá bộ lọc</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              canEditFull={canManage}
              canDelete={canManage}
              categories={categories}
              onViewDetail={setDetailProduct}
              onEdit={setEditProduct}
              onToggleActive={handleToggleActive}
              onDelete={setDeleteProduct}
            />
          ))}
        </div>
      )}

      <ProductDetailModal
        product={detailProduct}
        open={!!detailProduct}
        onOpenChange={(o) => !o && setDetailProduct(null)}
      />

      <ProductFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => setShowCreate(false)}
      />

      <ProductFormDialog
        open={!!editProduct}
        product={editProduct}
        onClose={() => setEditProduct(undefined)}
        onSuccess={() => setEditProduct(undefined)}
      />

      <ProductCategoryManagerDialog
        open={showCategoryManager}
        onClose={() => setShowCategoryManager(false)}
      />

      <ProductDeleteDialog
        product={deleteProduct}
        pending={deleteMutation.isPending || updateMutation.isPending}
        error={deleteError}
        onCancel={closeDelete}
        onConfirm={handleDelete}
        onHide={handleHideFromDialog}
      />
    </div>
  )
}
