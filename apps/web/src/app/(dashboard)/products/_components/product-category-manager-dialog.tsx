"use client"

/**
 * Dialog quản lý DANH MỤC/NGÀNH sản phẩm + thuộc tính động. Chỉ mở
 * được cho người có quyền `products.manage` — caller (`products-screen.tsx`)
 * chịu trách nhiệm gate qua `usePermissions()`.
 *
 * Layout 2 cột (mirror ý tưởng "master-detail" gọn cho 1 dialog): trái = danh
 * sách danh mục + tạo mới (kể cả "Tạo từ mẫu"), phải = chi tiết danh mục đang
 * chọn + `ProductAttributeDefPanel`.
 */
import { useState } from "react"
import { Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import { cn } from "@/lib/utils"
import {
  useCreateProductCategory,
  useProductCategories,
  useUpdateProductCategory,
} from "@/hooks/products/use-product-categories"
import { ProductAttributeDefPanel } from "./product-attribute-def-panel"
import {
  CATEGORY_TEMPLATES,
  useCreateCategoryFromTemplate,
} from "./category-templates"
import type { ProductCategory } from "@/types/product-category"

export function ProductCategoryManagerDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { data: categories = [], isLoading } = useProductCategories(true)
  const createMutation = useCreateProductCategory()
  const updateMutation = useUpdateProductCategory()
  const { createFromTemplate, isPending: templatePending } = useCreateCategoryFromTemplate()

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = categories.find((c) => c.id === selectedId) ?? null

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Quản lý danh mục sản phẩm</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_TEMPLATES.map((tpl) => (
                <Button
                  key={tpl.code}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={templatePending}
                  onClick={() =>
                    createFromTemplate(tpl, {
                      onSuccess: (created) => setSelectedId(created.id),
                    })
                  }
                >
                  <Plus className="mr-1 size-3.5" /> Tạo từ mẫu: {tpl.name}
                </Button>
              ))}
            </div>

            <CreateCategoryForm
              isSubmitting={createMutation.isPending}
              onSubmit={(payload) =>
                createMutation.mutateAsync(payload).then((created) => setSelectedId(created.id))
              }
            />

            {isLoading ? (
              <p className="text-xs text-muted-foreground">Đang tải...</p>
            ) : categories.length === 0 ? (
              <p className="text-xs text-muted-foreground">Chưa có danh mục nào.</p>
            ) : (
              <ul className="space-y-1">
                {categories.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 max-sm:min-h-11 text-left text-sm transition-colors",
                        selectedId === c.id ? "border-primary bg-primary/5" : "hover:bg-muted",
                        !c.is_active && "opacity-60",
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {c.name} <span className="text-xs text-muted-foreground">({c.code})</span>
                      </span>
                      {!c.is_active && (
                        <Badge variant="secondary" className="shrink-0 bg-muted text-sm">
                          Đã tắt
                        </Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto border-t pt-3 md:border-t-0 md:border-l md:pt-0 md:pl-4">
            {!selected ? (
              <p className="text-sm text-muted-foreground">Chọn 1 danh mục bên trái để xem chi tiết.</p>
            ) : (
              <div className="space-y-4">
                <CategoryDetailForm
                  key={selected.id}
                  category={selected}
                  isSubmitting={updateMutation.isPending}
                  onSubmit={(payload) => updateMutation.mutate({ id: selected.id, payload })}
                />
                <ProductAttributeDefPanel key={selected.id} categoryId={selected.id} />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateCategoryForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean
  onSubmit: (payload: { code: string; name: string; description?: string | null }) => void | Promise<unknown>
}) {
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState("")

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!/^[A-Za-z0-9_-]{2,}$/.test(code)) {
      setError("Mã tối thiểu 2 ký tự — chỉ chữ, số, gạch ngang/dưới")
      return
    }
    if (name.trim().length < 2) {
      setError("Tên tối thiểu 2 ký tự")
      return
    }
    setError("")
    // Chỉ xoá ô nhập khi tạo thành công (lỗi đã được toast ở hook mutation).
    Promise.resolve(onSubmit({ code: code.trim(), name: name.trim() })).then(
      () => {
        setCode("")
        setName("")
      },
      () => undefined,
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-xs font-semibold text-muted-foreground">Thêm danh mục mới</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Mã (vd: retail)"
          className="h-8 max-sm:h-11"
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tên (vd: Bán lẻ)"
          className="h-8 max-sm:h-11"
        />
      </div>
      <p className="min-h-4 text-xs leading-4 text-destructive">{error}</p>
      <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
        Thêm danh mục
      </Button>
    </form>
  )
}

function CategoryDetailForm({
  category,
  isSubmitting,
  onSubmit,
}: {
  category: ProductCategory
  isSubmitting: boolean
  onSubmit: (payload: { name?: string; description?: string | null; is_active?: boolean }) => void
}) {
  const [name, setName] = useState(category.name)
  const [description, setDescription] = useState(category.description ?? "")
  const [isActive, setIsActive] = useState(category.is_active)

  return (
    <form
      key={category.id}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ name, description: description || null, is_active: isActive })
      }}
      className="space-y-2"
    >
      <p className="text-sm font-semibold">
        {category.name} <span className="text-xs text-muted-foreground">({category.code})</span>
      </p>
      <div className="space-y-1">
        <Label className="text-xs">Tên danh mục</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 max-sm:h-11" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Mô tả</Label>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <Label className="flex items-center gap-2 text-sm font-normal max-sm:min-h-11">
        <Checkbox checked={isActive} onCheckedChange={setIsActive} />
        Hiện trong dropdown chọn danh mục
      </Label>
      <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
        Lưu thay đổi
      </Button>
    </form>
  )
}
