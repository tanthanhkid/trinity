"use client"

/**
 * Modal chi tiết sản phẩm — màn "Sản phẩm" (tổng quát hoá đa ngành;
 * chuyển từ panel bên phải sang Center Modal). Mở được cho
 * MỌI role đăng nhập (mirror `GET /products/:id` — không có `@Roles`).
 *
 * Bố cục: Header = ảnh + badge trạng thái + tên + mã (tag); Body = giá nổi bật,
 * Thông tin chung, Mô tả, Thẻ, Thuộc tính (card nền nhẹ). Cả khối cuộn BÊN
 * TRONG modal (`max-h-[90dvh]`), nút đóng nằm ngoài vùng cuộn nên luôn thấy.
 * Animation fade + zoom lấy từ `DialogContent` dùng chung (không tự thêm).
 * Dữ liệu: `useAttributeDefs` chỉ fetch khi mở CÓ category (không đổi logic).
 */
import { XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatCurrency } from "@/lib/format"
import { useAttributeDefs, useProductCategories } from "@/hooks/products/use-product-categories"
import type { Product } from "@/types/product"
import type { ProductAttributeDef } from "@/types/product-category"
import { ProductCover } from "./product-cover"
import { ProductFeaturedBadge, ProductStatusBadge } from "./product-status-badge"

export function ProductDetailModal({
  product,
  open,
  onOpenChange,
}: {
  product: Product | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // `enabled` bên trong hook đã gate theo `categoryId != null` — gọi vô điều
  // kiện ở đây an toàn kể cả khi `product` là null (chưa mở modal).
  const { data: categories = [] } = useProductCategories(true)
  const { data: attributeDefs = [] } = useAttributeDefs(product?.category_id ?? null)
  const categoryName = categories.find((c) => c.id === product?.category_id)?.name ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90dvh] gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[680px]"
      >
        {product && (
          <>
            <DialogClose
              render={
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="Đóng"
                  className="absolute top-3 right-3 z-10 rounded-full bg-background/90 shadow-sm"
                />
              }
            >
              <XIcon />
            </DialogClose>
            <div className="max-h-[90dvh] overflow-y-auto overscroll-contain">
              <ProductCover product={product} className="h-44 w-full sm:h-52" />
              <div className="space-y-2 px-5 pt-5 sm:px-7">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ProductStatusBadge active={product.is_active} />
                  {product.is_featured && <ProductFeaturedBadge />}
                </div>
                <DialogTitle className="text-xl leading-snug font-bold sm:text-2xl">
                  {product.name}
                </DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-2">
                  {product.brand && <span>{product.brand}</span>}
                  <span
                    className="rounded-md border bg-[var(--color-app-surface-2)] px-2 py-0.5 font-mono text-xs font-medium text-foreground"
                    data-testid="product-code-tag"
                  >
                    {product.code}
                  </span>
                </DialogDescription>
              </div>
              <div className="flex flex-col gap-4 px-5 pt-4 pb-6 sm:px-7">
                <div
                  className="rounded-2xl bg-[var(--color-app-primary-soft)] px-5 py-4"
                  data-testid="product-price-block"
                >
                  <div className="text-xs font-medium text-[var(--color-app-primary-ink)]">Giá</div>
                  <div className="text-3xl font-bold text-[var(--color-app-primary-ink)]">
                    {product.price == null ? "—" : `${formatCurrency(product.price)} đ`}
                  </div>
                </div>

                <Section title="Thông tin chung">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <DetailMetric label="Danh mục" value={categoryName ?? "Chưa phân loại"} />
                    <DetailMetric
                      label="Trạng thái"
                      value={product.is_active ? "Đang mở bán" : "Ngừng bán"}
                    />
                  </div>
                </Section>

                {product.description && (
                  <Section title="Mô tả">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {product.description}
                    </p>
                  </Section>
                )}

                {product.tags.length > 0 && (
                  <Section title="Thẻ">
                    <div className="flex flex-wrap gap-1.5">
                      {product.tags.map((t) => (
                        <Badge key={t} variant="outline">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </Section>
                )}

                <AttributeValuesList
                  attributeDefs={attributeDefs}
                  attributes={product.attributes}
                />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border bg-[var(--color-app-surface-2)]/50 p-5">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </section>
  )
}

function AttributeValuesList({
  attributeDefs,
  attributes,
}: {
  attributeDefs: ProductAttributeDef[]
  attributes: Record<string, unknown>
}) {
  // Giá trị còn trong `attributes` nhưng KHÔNG còn định nghĩa (def bị xoá, hoặc
  // sản phẩm đổi danh mục / danh mục cũ chưa khai def) — vẫn phải thấy, không
  // được biến mất khỏi màn hình dù dữ liệu còn nguyên trong DB.
  const known = new Set(attributeDefs.map((d) => d.key))
  const orphans = Object.entries(attributes).filter(
    ([k, v]) => !known.has(k) && v !== null && v !== undefined && v !== "",
  )
  if (attributeDefs.length === 0 && orphans.length === 0) return null
  return (
    <>
      {attributeDefs.length > 0 && (
        <Section title="Thuộc tính">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {attributeDefs.map((def) => (
              <DetailMetric
                key={def.id}
                label={def.label}
                value={formatAttributeValue(attributes[def.key], def)}
              />
            ))}
          </div>
        </Section>
      )}
      {orphans.length > 0 && (
        <Section title="Thông tin khác đã lưu">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {orphans.map(([k, v]) => (
              <DetailMetric key={k} label={k} value={formatOrphanValue(v)} />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

function formatOrphanValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "Có" : "Không"
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(", ")
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

function formatAttributeValue(value: unknown, def: ProductAttributeDef): string {
  if (value === undefined || value === null || value === "") return "—"
  if (def.type === "boolean") return value ? "Có" : "Không"
  // Đổi kiểu def sau khi đã có dữ liệu (vd text → currency): giá trị không phải số
  // hiện NGUYÊN VĂN, không ép thành "0 đ" gây hiểu nhầm.
  if (def.type === "percent" || def.type === "currency") {
    const n = Number(value)
    if (typeof value === "object" || !Number.isFinite(n)) return formatOrphanValue(value)
    return def.type === "percent" ? `${value}%` : `${formatCurrency(n)} đ`
  }
  if (Array.isArray(value)) {
    const labels = value.map((v) => def.options?.find((o) => o.value === v)?.label ?? String(v))
    return labels.join(", ") || "—"
  }
  if (def.type === "select") {
    return def.options?.find((o) => o.value === value)?.label ?? String(value)
  }
  return String(value)
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius)] border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}
