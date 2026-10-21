"use client"

import { useState } from "react"
import { Archive, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePurgeProduct, useProducts } from "@/hooks/products/use-products"
import type { Product } from "@/types/product"

/**
 * Mục "Đã xoá (lưu trữ)" — CHỈ Quản trị. Sản phẩm đã xoá không còn ở danh mục / POS / trang bán hàng nhưng vẫn
 * giữ cho đơn cũ và liên hệ. "Xoá hẳn" chỉ được khi chưa đơn / liên hệ nào dùng (máy chủ trả 409 kèm lý do).
 */
export function ProductArchivedList() {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<Product | null>(null)
  const archived = useProducts({ archived: true }, { enabled: open })
  const purge = usePurgeProduct()
  const rows = archived.data ?? []

  return (
    <section aria-labelledby="products-archived" className="rounded-2xl border border-dashed p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Archive className="size-4 text-muted-foreground" aria-hidden />
        <h2 id="products-archived" className="text-sm font-medium">Sản phẩm đã xoá (lưu trữ)</h2>
        <Button variant="ghost" size="sm" className="ml-auto max-sm:min-h-11" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Ẩn danh sách" : "Xem"}
        </Button>
      </div>
      {open && (
        <div className="mt-3">
          {archived.isLoading ? (
            <LoadingBlock count={3} label="Đang tải sản phẩm đã xoá…" />
          ) : archived.isError && !archived.data ? (
            <ErrorState compact title="Không tải được sản phẩm đã xoá" error={archived.error} onRetry={() => void archived.refetch()} retrying={archived.isFetching} />
          ) : rows.length === 0 ? (
            <EmptyState message="Không có sản phẩm nào trong mục đã xoá." />
          ) : (
            <ul className="divide-y rounded-xl border bg-card" data-testid="products-archived">
              {rows.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{p.name}</span> <span className="text-muted-foreground">· {p.code}</span>
                  </span>
                  <Button variant="outline" size="sm" className="max-sm:min-h-11" onClick={() => setTarget(p)}>
                    <Trash2 className="mr-1 size-3.5" aria-hidden /> Xoá hẳn
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        tone="destructive"
        title="Xoá hẳn sản phẩm?"
        description={<>Xoá vĩnh viễn <b>{target?.name}</b> — không khôi phục được. Chỉ làm được khi chưa có đơn bán hàng / liên hệ nào dùng sản phẩm này.</>}
        confirmLabel="Xoá hẳn"
        pending={purge.isPending}
        onConfirm={() => {
          const p = target
          if (!p) return
          purge.mutate(p.id, {
            onSuccess: () => {
              setTarget(null)
              toast.success(`Đã xoá hẳn “${p.name}”`)
            },
            // 409: máy chủ nói rõ đang có bao nhiêu đơn / liên hệ dùng — giữ nguyên câu đó.
            onError: (err) => toast.error(getApiErrorMessage(err, "Chưa xoá hẳn được sản phẩm")),
          })
        }}
      />
    </section>
  )
}
