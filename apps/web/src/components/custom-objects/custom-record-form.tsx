"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { fieldErrorsOf, useCustomRecordMutations } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import type { CustomObjectDef, CustomRecord, CustomRecordData } from "@/types/custom-objects"
import { CustomFieldInput } from "./custom-field-input"
import { CustomFieldValue } from "./custom-field-value"
import { RelationCombobox } from "./relation-combobox"

const WIDE = new Set(["long_text", "multi_select"])

/** Trường nhập được (công thức chỉ đọc). */
const isInput = (t: string) => t !== "formula"

function initialValues(def: CustomObjectDef, rec?: CustomRecord): CustomRecordData {
  const out: CustomRecordData = {}
  // Ô Có/Không bắt buộc: hiện "Không" thì giá trị thật phải là false (nếu để trống BE báo "bắt buộc" dù giao diện đã hiện Không).
  if (!rec) { for (const f of def.fields) if (f.type === "boolean" && f.required) out[f.key] = false; return out }
  for (const f of def.fields) if (isInput(f.type) && rec.data[f.key] !== undefined && rec.data[f.key] !== null) out[f.key] = rec.data[f.key]
  return out
}

/**
 * Form tạo / sửa bản ghi — SINH TỪ ĐỊNH NGHĨA trường. Gửi lên: tạo = chỉ trường có giá trị; sửa = trường đổi
 * (đã xoá → null). Lỗi theo trường của BE hiện ngay dưới ô. `readOnly` (không có quyền sửa) hiện giá trị thuần.
 */
export function CustomRecordForm({ def, record, readOnly = false }: { def: CustomObjectDef; record?: CustomRecord; readOnly?: boolean }) {
  const router = useRouter()
  const { create, update } = useCustomRecordMutations(def.key)
  const [values, setValues] = useState<CustomRecordData>(() => initialValues(def, record))
  const [owner, setOwner] = useState<number | undefined>(record?.owner_id ?? undefined)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pending = create.isPending || update.isPending
  const basePath = `/x/${def.key}`

  function set(key: string, v: unknown) {
    setValues((prev) => {
      const next = { ...prev }
      if (v === undefined) delete next[key]; else next[key] = v
      return next
    })
    setErrors((e) => (e[key] ? { ...e, [key]: "" } : e))
  }

  function buildPayload(): { data: CustomRecordData; owner_id?: number } {
    const data: CustomRecordData = {}
    for (const f of def.fields) {
      if (!isInput(f.type)) continue
      const v = values[f.key]
      if (!record) { if (v !== undefined) data[f.key] = v; continue }
      const before = record.data[f.key]
      if (JSON.stringify(v ?? null) !== JSON.stringify(before ?? null)) data[f.key] = v ?? null
    }
    const ownerChanged = owner !== undefined && owner !== (record?.owner_id ?? undefined)
    return ownerChanged ? { data, owner_id: owner } : { data }
  }

  function onError(err: unknown) {
    const fe = fieldErrorsOf(err)
    setErrors(fe)
    toast.error(Object.keys(fe).length ? "Vui lòng kiểm tra lại các ô báo lỗi" : getApiErrorMessage(err, "Không lưu được, vui lòng thử lại"))
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pending) return
    const missing: Record<string, string> = {}
    for (const f of def.fields) if (f.required && isInput(f.type) && values[f.key] === undefined) missing[f.key] = `“${f.label}” là bắt buộc`
    if (Object.keys(missing).length) { setErrors(missing); toast.error("Vui lòng điền các ô bắt buộc"); return }
    const payload = buildPayload()
    if (record) {
      update.mutate({ id: record.id, input: payload }, { onSuccess: () => { toast.success("Đã lưu thay đổi"); router.push(basePath) }, onError })
    } else {
      create.mutate(payload, { onSuccess: () => { toast.success(`Đã thêm ${def.label.toLowerCase()}`); router.push(basePath) }, onError })
    }
  }

  return (
    <form onSubmit={submit} method="post" noValidate className="space-y-4">
      <Card className="overflow-visible rounded-2xl">
        <CardContent className="grid grid-cols-1 gap-x-4 gap-y-3 p-4 sm:grid-cols-2 sm:p-5">
          {def.fields.map((f) => (
            <div key={f.key} className={cn("space-y-1.5", (WIDE.has(f.type) || (f.type === "relation" && f.options.multiple)) && "sm:col-span-2")}>
              <Label htmlFor={`cf-${f.key}`}>{f.label}{f.required && !readOnly ? " *" : ""}</Label>
              {readOnly || f.type === "formula" ? (
                <div className="min-h-9 text-sm">{record ? <CustomFieldValue field={f} record={record} /> : <span className="text-muted-foreground">Tự tính</span>}</div>
              ) : (
                <CustomFieldInput field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} invalid={!!errors[f.key]} labels={record?.relations[f.key]} />
              )}
              {f.help_text && !errors[f.key] && <p className="text-xs text-muted-foreground">{f.help_text}</p>}
              <p className="min-h-4 text-xs leading-4 text-destructive" role={errors[f.key] ? "alert" : undefined}>{errors[f.key] ?? ""}</p>
            </div>
          ))}
          {!readOnly && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cf-__owner">Người phụ trách</Label>
              <RelationCombobox id="cf-__owner" kind="__users" forPerm="manage" value={owner} onChange={(v) => setOwner(typeof v === "number" ? v : undefined)}
                initialLabels={record?.owner_id && record.owner_name ? [{ id: record.owner_id, title: record.owner_name, accessible: true }] : []}
                placeholder="Mặc định: bạn" />
              <p className="min-h-4 text-xs leading-4 text-destructive" role={errors.owner_id ? "alert" : undefined}>{errors.owner_id ?? ""}</p>
            </div>
          )}
          {errors._data && <p className="text-sm text-destructive sm:col-span-2" role="alert">{errors._data}</p>}
        </CardContent>
      </Card>
      {!readOnly && (
        <MobileActionBar>
          <Button type="button" variant="ghost" onClick={() => router.push(basePath)} disabled={pending}>Huỷ</Button>
          <Button type="submit" disabled={pending}>{pending && <Loader2 className="mr-1.5 size-4 animate-spin" />}{record ? "Lưu thay đổi" : `Lưu ${def.label.toLowerCase()}`}</Button>
        </MobileActionBar>
      )}
    </form>
  )
}
