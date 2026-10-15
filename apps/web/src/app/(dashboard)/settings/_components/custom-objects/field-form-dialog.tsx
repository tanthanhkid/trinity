"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useCustomFieldMutations, useCustomObjectList } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { FIELD_TYPE_META, FIELD_TYPE_ORDER, TITLE_TYPES, UNIQUE_TYPES } from "@/lib/custom-objects/field-meta"
import type { CustomFieldDef, CustomFieldType, CustomObjectDef, SelectChoice } from "@/types/custom-objects"
import { ChoicesEditor } from "./choices-editor"
import { FormulaEditor } from "./formula-editor"
import { slugifyObjectKey } from "./object-form-dialog"

const CONTACT = "__contact__"

function FlagRow({ id, title, hint, checked, disabled, onChange }: { id: string; title: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center justify-between gap-3 rounded-lg border p-3 max-sm:min-h-14">
      <span><span className="block font-medium">{title}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} />
    </label>
  )
}

/** Thêm / sửa 1 trường. Mã trường bất biến; kiểu chỉ đổi được khi trường chưa có dữ liệu (BE kiểm, trả lý do cụ thể). */
export function FieldFormDialog({ open, onOpenChange, object, field }: { open: boolean; onOpenChange: (o: boolean) => void; object: CustomObjectDef; field?: CustomFieldDef }) {
  const editing = !!field
  const { create, update } = useCustomFieldMutations(object.key)
  const objects = useCustomObjectList(open)
  const [label, setLabel] = useState(field?.label ?? "")
  const [key, setKey] = useState(field?.key ?? "")
  const [keyTouched, setKeyTouched] = useState(editing)
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text")
  const [required, setRequired] = useState(field?.required ?? false)
  const [unique, setUnique] = useState(field?.is_unique ?? false)
  const [isTitle, setIsTitle] = useState(field?.is_title ?? object.fields.every((f) => !f.is_title))
  const [showInList, setShowInList] = useState(field?.show_in_list ?? true)
  const [help, setHelp] = useState(field?.help_text ?? "")
  const [choices, setChoices] = useState<SelectChoice[]>(field?.options.choices?.length ? field.options.choices : [{ value: "", label: "" }, { value: "", label: "" }])
  const [target, setTarget] = useState<string>(field?.options.target === "contact" ? CONTACT : field?.options.target_object_id ? String(field.options.target_object_id) : "")
  const [multiple, setMultiple] = useState(field?.options.multiple ?? false)
  const [expression, setExpression] = useState(field?.options.expression ?? "")
  const [format, setFormat] = useState<"number" | "currency" | "percent">(field?.options.format ?? "number")
  const pending = create.isPending || update.isPending
  const choiceType = type === "select" || type === "multi_select"

  function buildOptions(): Record<string, unknown> | undefined {
    if (choiceType) return { choices: choices.filter((c) => c.label.trim()).map((c) => ({ ...c, label: c.label.trim(), value: c.value || undefined })) }
    if (type === "relation") return target === CONTACT ? { target: "contact", multiple } : { target_object_id: Number(target), multiple }
    if (type === "formula") return { expression: expression.trim(), format }
    return undefined
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim()) { toast.error("Vui lòng nhập tên trường"); return }
    if (type === "relation" && !target) { toast.error("Chọn tính năng mà trường này liên kết tới"); return }
    if (choiceType && !choices.some((c) => c.label.trim())) { toast.error("Nhập ít nhất một lựa chọn"); return }
    if (type === "formula" && !expression.trim()) { toast.error("Nhập biểu thức công thức"); return }
    // Cờ chỉ gửi khi KIỂU cho phép (ô bật/tắt bị ẩn nhưng state vẫn giữ giá trị cũ → BE sẽ từ chối 400).
    const common = {
      label: label.trim(), type, required: type !== "formula" && required, is_unique: UNIQUE_TYPES.includes(type) && unique,
      is_title: TITLE_TYPES.includes(type) && isTitle, show_in_list: showInList, help_text: help.trim() || null, options: buildOptions(),
    }
    const done = () => { toast.success(editing ? "Đã lưu trường" : "Đã thêm trường"); onOpenChange(false) }
    const fail = (err: unknown) => toast.error(getApiErrorMessage(err, "Không lưu được, vui lòng thử lại"))
    if (editing) update.mutate({ fieldKey: field.key, input: common }, { onSuccess: done, onError: fail })
    else create.mutate({ ...common, key: key || undefined }, { onSuccess: done, onError: fail })
  }

  const targets = (objects.data ?? [])
  const lockedValues = new Set((field?.options.choices ?? []).map((c) => c.value))

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Sửa trường “${field.label}”` : `Thêm trường cho “${object.label}”`}</DialogTitle>
          <DialogDescription>{FIELD_TYPE_META[type].hint}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cf-label">Tên trường *</Label>
              <Input id="cf-label" value={label} maxLength={100} autoFocus placeholder="Tên khách hàng"
                onChange={(e) => { setLabel(e.target.value); if (!keyTouched) setKey(slugifyObjectKey(e.target.value)) }} />
            </div>
            <div className="space-y-1.5">
              <Label>Kiểu dữ liệu *</Label>
              <Select value={type} onValueChange={(v) => { if (v) setType(v as CustomFieldType) }}>
                <SelectTrigger aria-label="Kiểu dữ liệu"><SelectValue>{(v) => FIELD_TYPE_META[v as CustomFieldType]?.label ?? <span className="text-muted-foreground">Chọn…</span>}</SelectValue></SelectTrigger>
                <SelectContent>{FIELD_TYPE_ORDER.map((t) => <SelectItem key={t} value={t}>{FIELD_TYPE_META[t].label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-key">Mã trường</Label>
            <Input id="cf-key" value={key} maxLength={48} disabled={editing} placeholder="ho_ten" onChange={(e) => { setKey(e.target.value.toLowerCase()); setKeyTouched(true) }} />
            <p className="text-xs text-muted-foreground">Dùng trong công thức và bộ lọc; không đổi được sau khi tạo.</p>
          </div>

          {choiceType && (
            <div className="space-y-1.5"><Label>Danh sách lựa chọn *</Label><ChoicesEditor value={choices} onChange={setChoices} lockedValues={lockedValues} /></div>
          )}
          {type === "relation" && (
            <div className="space-y-2">
              <Label>Liên kết tới *</Label>
              <Select value={target} onValueChange={(v) => setTarget(v ?? "")}>
                <SelectTrigger aria-label="Liên kết tới">
                  <SelectValue>{(v) => (v === CONTACT ? "Danh bạ khách hàng" : targets.find((o) => String(o.id) === v)?.label_plural ?? <span className="text-muted-foreground">Chọn tính năng…</span>)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CONTACT}>Danh bạ khách hàng</SelectItem>
                  {targets.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label_plural}{o.id === object.id ? " (chính nó)" : ""}</SelectItem>)}
                </SelectContent>
              </Select>
              <FlagRow id="cf-multi" title="Chọn nhiều" hint="Cho phép liên kết tới nhiều bản ghi (vd Khách hàng → nhiều Hợp đồng)" checked={multiple} disabled={editing} onChange={setMultiple} />
            </div>
          )}
          {type === "formula" && (
            <div className="space-y-1.5">
              <Label>Biểu thức *</Label>
              <FormulaEditor objectKey={object.key} fields={object.fields} editingKey={field?.key} expression={expression} onChange={setExpression} />
              <div className="space-y-1.5 pt-1">
                <Label>Hiển thị kết quả</Label>
                <Select value={format} onValueChange={(v) => { if (v) setFormat(v as typeof format) }}>
                  <SelectTrigger aria-label="Hiển thị kết quả"><SelectValue>{(v) => (v === "currency" ? "Tiền (VNĐ)" : v === "percent" ? "Phần trăm" : "Số")}</SelectValue></SelectTrigger>
                  <SelectContent><SelectItem value="number">Số</SelectItem><SelectItem value="currency">Tiền (VNĐ)</SelectItem><SelectItem value="percent">Phần trăm</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="cf-help">Ghi chú hướng dẫn</Label>
            <Input id="cf-help" value={help} maxLength={300} placeholder="Hiện dưới ô nhập" onChange={(e) => setHelp(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {type !== "formula" && <FlagRow id="cf-required" title="Bắt buộc" hint="Phải nhập khi lưu bản ghi" checked={required} onChange={setRequired} />}
            {UNIQUE_TYPES.includes(type) && <FlagRow id="cf-unique" title="Không trùng" hint="Hai bản ghi không có cùng giá trị" checked={unique} onChange={setUnique} />}
            {TITLE_TYPES.includes(type) && <FlagRow id="cf-title" title="Làm tiêu đề" hint="Tên hiển thị của bản ghi (mỗi tính năng một trường)" checked={isTitle} disabled={field?.is_title} onChange={setIsTitle} />}
            <FlagRow id="cf-list" title="Hiện ở danh sách" hint="Làm một cột của bảng" checked={showInList} onChange={setShowInList} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Huỷ</Button>
            <Button type="submit" disabled={pending}>{pending && <Loader2 className="mr-1.5 size-4 animate-spin" />}{editing ? "Lưu trường" : "Thêm trường"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
