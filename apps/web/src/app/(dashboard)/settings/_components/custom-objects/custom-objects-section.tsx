"use client"

import { useState } from "react"
import { ChevronRight, LayoutTemplate, Loader2, Plus, Shapes } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { useCustomObjectList } from "@/hooks/custom-objects/use-custom-objects"
import { customIcon } from "@/lib/custom-objects/icons"
import { CustomObjectEditor } from "./custom-object-editor"
import { TemplateDialog } from "./template-dialog"
import { ObjectFormDialog } from "./object-form-dialog"

/**
 * Khu “Tính năng tuỳ biến” trong Cài đặt › Tính năng: người dùng tự thêm tính năng (thực thể + trường) để
 * hiện trên menu — Dự án, Khách hàng, Hợp đồng… tuỳ nhu cầu. Chỉ hiện với quyền `custom_objects.manage` (BE kiểm lại).
 */
export function CustomObjectsSection() {
  const list = useCustomObjectList()
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [templating, setTemplating] = useState(false)

  if (selected) return <CustomObjectEditor objectKey={selected} onBack={() => setSelected(null)} />

  return (
    <section className="space-y-3" aria-labelledby="custom-objects-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="custom-objects-heading" className="text-lg font-semibold">Tính năng tuỳ biến</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Tự thêm tính năng riêng cho công ty (ví dụ Dự án, Khách hàng, Hợp đồng…): đặt tên, thêm các trường dữ liệu, rồi dùng ngay trên menu.
            Ai được xem/sửa do mục “Vai trò” quyết định.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setTemplating(true)}><LayoutTemplate className="mr-1.5 size-4" /> Dùng mẫu theo ngành</Button>
          <Button onClick={() => setAdding(true)}><Plus className="mr-1.5 size-4" /> Thêm tính năng</Button>
        </div>
      </div>

      {list.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>}
      {list.isSuccess && list.data.length === 0 && (
        <Card className="rounded-2xl"><ShellEmptyState icon={Shapes} title="Chưa có tính năng tuỳ biến nào" description="Bấm “Thêm tính năng” để tạo tính năng đầu tiên." /></Card>
      )}
      {list.isSuccess && list.data.length > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="divide-y p-0">
            {list.data.map((o) => {
              const Icon = customIcon(o.icon)
              return (
                <button key={o.key} type="button" onClick={() => setSelected(o.key)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 max-sm:min-h-14">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]"><Icon className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium">{o.label_plural}
                      {!o.is_active && <Badge variant="outline">Đang tắt</Badge>}
                      {!o.show_in_nav && <Badge variant="outline">Ẩn khỏi menu</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">{o.field_count} trường · {o.record_count} bản ghi · <span className="font-mono">/x/{o.key}</span></span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )
            })}
          </CardContent>
        </Card>
      )}
      {templating && <TemplateDialog open onOpenChange={setTemplating} />}
      {adding && <ObjectFormDialog open onOpenChange={setAdding} onCreated={(k) => setSelected(k)} />}
    </section>
  )
}
