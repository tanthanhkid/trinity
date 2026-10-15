"use client"

/**
 * Thẻ sản phẩm — màn "Sản phẩm" (tổng quát hoá đa ngành).
 * Chi tiết từng thuộc tính động xem `ProductDetailModal`.
 *
 * hiển thị ảnh minh hoạ (`ProductCover`). Giá nổi
 * bật, trạng thái dạng badge, "Xem chi tiết" là nút chính (solid + icon), action
 * phụ (Sửa/Tắt) ghost, "Xoá" màu destructive — toàn bộ dùng token có sẵn.
 */
import { Eye, MoreHorizontal, Pencil, Power, PowerOff, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatCurrency } from "@/lib/format"
import type { Product } from "@/types/product"
import type { ProductCategory } from "@/types/product-category"
import { ProductCover } from "./product-cover"
import { ProductFeaturedBadge, ProductStatusBadge } from "./product-status-badge"

interface ProductCardProps {
  product: Product
  /** Quyền `products.manage` của người xem — cha tính 1 lần qua `usePermissions()`. */
  canEditFull: boolean
  canDelete: boolean
  categories: ProductCategory[]
  onViewDetail: (product: Product) => void
  onEdit: (product: Product) => void
  onToggleActive: (product: Product) => void
  onDelete: (product: Product) => void
}

export function ProductCard({
  product,
  canEditFull,
  canDelete,
  categories,
  onViewDetail,
  onEdit,
  onToggleActive,
  onDelete,
}: ProductCardProps) {
  const categoryName = categories.find((c) => c.id === product.category_id)?.name ?? null
  const attributeCount = Object.values(product.attributes).filter((v) => v != null && v !== "").length

  return (
    <div
      className={cn(
        "group flex flex-col overflow-hidden rounded-[var(--radius)] border bg-card shadow-[var(--shadow-card)] transition-all hover:-translate-y-0.5 hover:border-[var(--color-app-primary)] hover:shadow-md",
      )}
    >
      {/* Mờ CHỈ ảnh bìa: opacity trên cả thẻ kéo chữ phụ xuống ~3,4:1 (< AA 4.5:1). */}
      <ProductCover
        product={product}
        className={cn("h-36 w-full", !product.is_active && "opacity-60 grayscale")}
      />

      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <ProductStatusBadge active={product.is_active} />
          {product.is_featured && <ProductFeaturedBadge />}
        </div>

        <div className="min-w-0 space-y-1">
          <h3 className="truncate text-base font-semibold leading-snug">{product.name}</h3>
          <div className="truncate text-sm text-muted-foreground">
            {product.brand ?? "—"} · {product.code}
          </div>
        </div>

        <div className="space-y-0.5">
          <div className="text-xs font-medium text-muted-foreground">Giá</div>
          <div className="text-xl font-bold text-[var(--color-app-primary-ink)]">
            {product.price == null ? "—" : `${formatCurrency(product.price)} đ`}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {categoryName ?? "Chưa phân loại"}
          </div>
        </div>

        {product.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {product.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-sm font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {product.description && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{product.description}</p>
        )}

        {attributeCount > 0 && (
          <div className="text-xs font-medium text-[var(--color-app-primary-ink)]">
            {attributeCount} thuộc tính đã khai báo
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Button variant="outline" className="h-10 flex-1 max-sm:min-w-0" onClick={() => onViewDetail(product)}>
            <Eye className="mr-1.5 size-4" /> Xem chi tiết
          </Button>
          {canEditFull && (
            <Button
              variant="outline"
              className="h-10"
              onClick={() => onEdit(product)}
            >
              <Pencil className="mr-1 size-3.5" /> Sửa
            </Button>
          )}
          {canEditFull && (
            <Button size="sm" variant="ghost" className="max-sm:hidden" onClick={() => onToggleActive(product)}>
              {product.is_active ? (
                <>
                  <PowerOff className="mr-1 size-3.5" /> Ẩn
                </>
              ) : (
                <>
                  <Power className="mr-1 size-3.5" /> Hiện lại
                </>
              )}
            </Button>
          )}
          {(canEditFull || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Thao tác khác"
                    className="sm:hidden"
                  />
                }
              >
                <MoreHorizontal aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditFull && (
                  <DropdownMenuItem className="min-h-11" onClick={() => onToggleActive(product)}>
                    {product.is_active ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                    {product.is_active ? "Ẩn" : "Hiện lại"}
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    className="min-h-11"
                    onClick={() => onDelete(product)}
                  >
                    <Trash2 aria-hidden /> Xoá
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="destructive"
              className="max-sm:hidden"
              onClick={() => onDelete(product)}
            >
              <Trash2 className="mr-1 size-3.5" /> Xoá
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
