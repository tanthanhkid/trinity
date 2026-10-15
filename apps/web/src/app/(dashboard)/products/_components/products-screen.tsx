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
import { Loader2, Plus, Settings2 } from "lucide-react"
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
  const { data: products = [], isLoading } = useProducts()
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
      onSuccess: closeDelete,
      onError: (err) =>
        setDeleteError({
          message: getApiErrorMessage(err, "Không xoá được sản phẩm, thử lại sau"),
          conflict: axios.isAxiosError(err) && err.response?.status === 409,
        }),
    })
  }

  function handleHideFromDialog(product: Product) {
    updateMutation.mutate(
      { id: product.id, payload: { is_active: false } },
      { onSuccess: closeDelete },
    )
  }

  function clearFilters() {
    setSearch("")
    setProjectFilter(ALL_SENTINEL)
    setCategoryFilter(ALL_SENTINEL)
    setShowInactive(false)
  }

  function handleToggleActive(product: Product) {
    updateMutation.mutate({ id: product.id, payload: { is_active: !product.is_active } })
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
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-[var(--color-app-primary-ink)]" />
        </div>
      ) : products.length === 0 ? (
        <div className="space-y-3 rounded-2xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          <p>Chưa có sản phẩm nào.</p>
          {canManage && (
            <Button variant="outline" onClick={() => setShowCreate(true)}>
              <Plus className="mr-1.5 size-4" /> Thêm sản phẩm
            </Button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="space-y-3 rounded-2xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          <p>Không có sản phẩm nào khớp bộ lọc.</p>
          <Button variant="ghost" onClick={clearFilters}>
            Xoá bộ lọc
          </Button>
        </div>
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
