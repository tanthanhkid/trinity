"use client"

/**
 * Panel định nghĩa thuộc tính động của 1 danh mục — danh sách +
 * thêm/xoá. RBAC ghi = quyền `products.manage` — caller
 * (`product-category-manager-dialog.tsx`) chịu trách nhiệm gate hiện panel này.
 */
import { useState } from "react"
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  useAttributeDefs,
  useCreateAttributeDef,
  useDeleteAttributeDef,
  useUpdateAttributeDef,
} from "@/hooks/products/use-product-categories"
import { AttributeDefForm } from "./attribute-def-form"
import { PRODUCT_ATTRIBUTE_TYPE_LABELS, type ProductAttributeDef } from "@/types/product-category"

export function ProductAttributeDefPanel({ categoryId }: { categoryId: number }) {
  const { data: defs = [], isLoading } = useAttributeDefs(categoryId)
  const createMutation = useCreateAttributeDef()
  const deleteMutation = useDeleteAttributeDef()
  const updateMutation = useUpdateAttributeDef()
  const [toDelete, setToDelete] = useState<ProductAttributeDef | null>(null)
  const [editing, setEditing] = useState<ProductAttributeDef | null>(null)

  /** Đổi chỗ 2 thuộc tính liền kề rồi ĐÁNH SỐ LẠI cả danh sách (sort_order cũ có thể trùng nhau, vd toàn 0). */
  function move(index: number, dir: -1 | 1) {
    if (!defs[index] || !defs[index + dir]) return
    const next = [...defs]
    ;[next[index], next[index + dir]] = [next[index + dir], next[index]]
    // Chạy song song + chờ hết: chỉ mutate những dòng đổi; lỗi giữa chừng đã có toast
    // toàn cục, và lần bấm kế tiếp đánh số lại nên không kẹt trạng thái nửa vời.
    void Promise.allSettled(
      next
        .map((d, i) => ({ d, i }))
        .filter(({ d, i }) => d.sort_order !== i)
        .map(({ d, i }) => updateMutation.mutateAsync({ id: d.id, payload: { sort_order: i } })),
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Thuộc tính động</p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Đang tải...</p>
      ) : defs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Danh mục này chưa có thuộc tính nào.</p>
      ) : (
        <ul className="space-y-1.5">
          {defs.map((def, index) => (
            <li
              key={def.id}
              className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-sm"
            >
              <div className="min-w-0">
                <span className="font-medium">{def.label}</span>{" "}
                <span className="text-xs text-muted-foreground">({def.key})</span>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="text-sm font-normal">
                    {PRODUCT_ATTRIBUTE_TYPE_LABELS[def.type]}
                  </Badge>
                  {def.is_required && (
                    <Badge variant="secondary" className="text-sm font-normal">
                      Bắt buộc
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center">
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={index === 0 || updateMutation.isPending}
                onClick={() => move(index, -1)}
                aria-label={`Đưa thuộc tính ${def.label} lên trên`}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={index === defs.length - 1 || updateMutation.isPending}
                onClick={() => move(index, 1)}
                aria-label={`Đưa thuộc tính ${def.label} xuống dưới`}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setEditing(def)}
                aria-label={`Sửa thuộc tính ${def.label}`}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setToDelete(def)}
                aria-label={`Xoá thuộc tính ${def.label}`}
              >
                <Trash2 className="size-4" />
              </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <AttributeDefForm
          key={editing.id}
          initial={editing}
          isSubmitting={updateMutation.isPending}
          onCancel={() => setEditing(null)}
          onSubmit={({ label, type, is_required, options }) =>
            updateMutation.mutate(
              { id: editing.id, payload: { label, type, is_required, options } },
              { onSuccess: () => setEditing(null) },
            )
          }
        />
      ) : (
        <AttributeDefForm
          isSubmitting={createMutation.isPending}
          onSubmit={(payload) =>
            // sort_order = cuối danh sách hiện tại → thuộc tính mới luôn nằm dưới cùng
            createMutation.mutateAsync({ categoryId, payload: { ...payload, sort_order: defs.length } })
          }
        />
      )}

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Xoá thuộc tính</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Xoá thuộc tính <strong>{toDelete?.label}</strong>? Sản phẩm đã nhập giá trị cho thuộc
            tính này sẽ GIỮ NGUYÊN dữ liệu cũ (vẫn xem được ở chi tiết sản phẩm nhưng không còn trong
            form sửa và không được validate nữa) — thao tác này KHÔNG hoàn tác được.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              Huỷ
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!toDelete) return
                deleteMutation.mutate(toDelete.id, { onSuccess: () => setToDelete(null) })
              }}
            >
              Xoá
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
