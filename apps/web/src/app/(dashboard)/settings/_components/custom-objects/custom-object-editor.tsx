"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useCustomFieldMutations, useCustomObjectDef, useDeleteCustomObject } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { FIELD_TYPE_META } from "@/lib/custom-objects/field-meta"
import { customIcon } from "@/lib/custom-objects/icons"
import type { CustomFieldDef } from "@/types/custom-objects"
import { FieldFormDialog } from "./field-form-dialog"
import { ObjectFormDialog } from "./object-form-dialog"

/** Màn cấu hình 1 tính năng: thông tin chung + danh sách trường (thêm/sửa/xoá/đổi thứ tự) + xoá tính năng. */
export function CustomObjectEditor({ objectKey, onBack }: { objectKey: string; onBack: () => void }) {
  const q = useCustomObjectDef(objectKey)
  const fieldsApi = useCustomFieldMutations(objectKey)
  const del = useDeleteCustomObject()
  const [fieldDialog, setFieldDialog] = useState<{ field?: CustomFieldDef } | null>(null)
  const [editInfo, setEditInfo] = useState(false)
  const [delField, setDelField] = useState<CustomFieldDef | null>(null)
  const [delObject, setDelObject] = useState(false)

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>
  if (q.isError || !q.data) return <div className="space-y-3"><p className="text-sm text-destructive">{getApiErrorMessage(q.error, "Không tải được tính năng này")}</p><Button variant="outline" onClick={onBack}>Quay lại</Button></div>
  const obj = q.data
  const Icon = customIcon(obj.icon)

  function move(i: number, dir: -1 | 1) {
    const keys = obj.fields.map((f) => f.key)
    const j = i + dir
    if (j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    fieldsApi.reorder.mutate(keys, { onError: (e) => toast.error(getApiErrorMessage(e, "Không đổi được thứ tự")) })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="mr-1.5 size-4" /> Danh sách tính năng</Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Link href={`/x/${obj.key}`} className={buttonVariants({ variant: "outline" }) + " max-sm:min-h-11"}><ExternalLink className="mr-1.5 size-4" /> Mở trang dữ liệu</Link>
          <Button variant="outline" onClick={() => setEditInfo(true)}><Pencil className="mr-1.5 size-4" /> Sửa thông tin</Button>
        </div>
      </div>

      <Card className="rounded-2xl">
        <CardContent className="flex items-start gap-3 p-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]"><Icon className="size-5" /></span>
          <div className="min-w-0 space-y-1">
            <p className="text-lg font-semibold">{obj.label_plural} <span className="font-mono text-xs font-normal text-muted-foreground">/x/{obj.key}</span></p>
            {obj.description && <p className="text-sm text-muted-foreground">{obj.description}</p>}
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">{obj.show_in_nav ? "Hiện trên menu" : "Ẩn khỏi menu"}</Badge>
              {!obj.is_active && <Badge variant="outline">Đang tắt</Badge>}
              {obj.visible_role_ids.length > 0 && <Badge variant="outline">Giới hạn theo {obj.visible_role_ids.length} vai trò</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Các trường ({obj.fields.length})</h3>
        <Button onClick={() => setFieldDialog({})}><Plus className="mr-1.5 size-4" /> Thêm trường</Button>
      </div>
      <Card className="rounded-2xl">
        <CardContent className="divide-y p-0">
          {obj.fields.length === 0 && <p className="p-5 text-sm text-muted-foreground">Chưa có trường nào. Hãy thêm trường đầu tiên (thường là “Tên” — làm tiêu đề).</p>}
          {obj.fields.map((f, i) => (
            <div key={f.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex flex-wrap items-center gap-1.5 font-medium">
                  {f.label}
                  {f.is_title && <Badge variant="outline">Tiêu đề</Badge>}
                  {f.required && <Badge variant="outline">Bắt buộc</Badge>}
                  {f.is_unique && <Badge variant="outline">Không trùng</Badge>}
                </p>
                <p className="text-xs text-muted-foreground"><span className="font-mono">{f.key}</span> · {FIELD_TYPE_META[f.type].label}{f.type === "relation" && f.options.target_label ? ` → ${f.options.target_label}` : f.type === "relation" && f.options.target === "contact" ? " → Danh bạ" : ""}{f.type === "formula" ? ` = ${f.options.expression}` : ""}</p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={`Đưa “${f.label}” lên`} disabled={i === 0 || fieldsApi.reorder.isPending} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                <Button variant="ghost" size="icon" aria-label={`Đưa “${f.label}” xuống`} disabled={i === obj.fields.length - 1 || fieldsApi.reorder.isPending} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                <Button variant="outline" size="sm" onClick={() => setFieldDialog({ field: f })}><Pencil className="mr-1 size-3.5" /> Sửa</Button>
                <Button variant="ghost" size="icon" aria-label={`Xoá trường “${f.label}”`} onClick={() => setDelField(f)}><Trash2 className="size-4 text-destructive" /></Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="border-t pt-4">
        <Button variant="outline" className="text-destructive" onClick={() => setDelObject(true)}><Trash2 className="mr-1.5 size-4" /> Xoá tính năng này</Button>
      </div>

      {fieldDialog && <FieldFormDialog key={fieldDialog.field?.key ?? "new"} open onOpenChange={(o) => { if (!o) setFieldDialog(null) }} object={obj} field={fieldDialog.field} />}
      {editInfo && <ObjectFormDialog key={obj.updated_at} open onOpenChange={setEditInfo} object={obj} />}
      <ConfirmDialog
        open={!!delField}
        onOpenChange={(o) => { if (!o) setDelField(null) }}
        title={`Xoá trường “${delField?.label}”?`}
        description="Trường sẽ ẩn khỏi form và danh sách. Dữ liệu đã nhập vẫn nằm trong bản ghi nhưng không hiện nữa. Trường đang là tiêu đề hoặc đang được công thức dùng sẽ không xoá được."
        confirmLabel="Xoá trường"
        pending={fieldsApi.remove.isPending}
        onConfirm={() => { if (delField) fieldsApi.remove.mutate(delField.key, { onSuccess: () => { setDelField(null); toast.success("Đã xoá trường") }, onError: (e) => toast.error(getApiErrorMessage(e, "Không xoá được trường")) }) }}
      />
      <ConfirmDialog
        open={delObject}
        onOpenChange={setDelObject}
        title={`Xoá tính năng “${obj.label_plural}”?`}
        description="Tính năng và toàn bộ dữ liệu của nó sẽ biến khỏi menu và danh sách. Không xoá được khi còn tính năng khác đang liên kết tới."
        confirmLabel="Xoá tính năng"
        pending={del.isPending}
        onConfirm={() => del.mutate(obj.key, { onSuccess: () => { setDelObject(false); toast.success("Đã xoá tính năng"); onBack() }, onError: (e) => toast.error(getApiErrorMessage(e, "Không xoá được tính năng")) })}
      />
    </div>
  )
}
