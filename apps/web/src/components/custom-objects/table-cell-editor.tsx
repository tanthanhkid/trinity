"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Switch } from "@/components/ui/switch"
import { getApiErrorMessage } from "@/lib/api-client"
import { isoToVnLocal, vnLocalToIso } from "@/lib/custom-objects/datetime"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomRecord } from "@/types/custom-objects"
import { CustomFieldInput } from "./custom-field-input"
import { CustomFieldValue } from "./custom-field-value"

/**
 * Trong ô bảng dùng ô nhập KHÔNG có popup ngoài ô (chọn một = <select>, ngày = ô ngày gốc) để "bấm ra ngoài = lưu" không cắt ngang
 * lúc chọn. Chọn một lưu ngay khi chọn; kiểu khác lưu khi Enter / Tab / bấm ra ngoài; Esc huỷ.
 */
const COMMIT_ON_CHANGE = new Set(["select"])
const NATIVE_CLASS = "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"

export interface CellSave { (recordId: number, key: string, value: unknown): Promise<unknown> }

/**
 * Một ô của kiểu xem Bảng: bấm để sửa tại chỗ bằng ĐÚNG ô nhập của form (CustomFieldInput) — BE vẫn kiểm kiểu/bắt buộc/
 * phạm vi như form. Công thức không sửa được. Lỗi hiện toast, ô quay về giá trị cũ.
 */
export function TableCellEditor({ field, record, canEdit, onSave }: { field: CustomFieldDef; record: CustomRecord; canEdit: boolean; onSave: CellSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraftState] = useState<unknown>(undefined)
  const draftRef = useRef<unknown>(undefined)
  const setDraft = (v: unknown) => { draftRef.current = v; setDraftState(v) }
  const [saving, setSaving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const editable = canEdit && field.type !== "formula"

  useEffect(() => {
    if (!editing) return
    box.current?.querySelector<HTMLElement>("input, textarea, select, [contenteditable='true'], button")?.focus()
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) void commit(draftRef.current) }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  async function commit(value: unknown) {
    setEditing(false)
    if (JSON.stringify(value ?? null) === JSON.stringify(record.data[field.key] ?? null)) return
    setSaving(true)
    try {
      await onSave(record.id, field.key, value === undefined ? null : value)
    } catch (e) {
      toast.error(getApiErrorMessage(e, `Không lưu được “${field.label}”`))
    } finally {
      setSaving(false)
    }
  }

  if (field.type === "boolean" && editable) {
    return <Switch checked={record.data[field.key] === true} disabled={saving} onCheckedChange={(c) => void commit(c)} aria-label={`${field.label} — ${record.title}`} />
  }
  if (!editing) {
    return (
      <div role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} data-testid="table-cell"
        className={cn("min-h-8 rounded px-1 py-1", editable && "cursor-text hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring")}
        onClick={() => { if (editable) { setDraft(record.data[field.key]); setEditing(true) } }}
        onKeyDown={(e) => { if (editable && (e.key === "Enter" || e.key === "F2")) { e.preventDefault(); setDraft(record.data[field.key]); setEditing(true) } }}>
        {saving ? <Loader2 className="size-4 animate-spin" aria-label="Đang lưu" /> : <CustomFieldValue field={field} record={record} />}
      </div>
    )
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setEditing(false) }
    if (e.key === "Enter" && !e.shiftKey && !["long_text", "link", "relation", "user"].includes(field.type)) { e.preventDefault(); void commit(draft) }
    if (e.key === "Tab" && !["link", "long_text"].includes(field.type)) void commit(draft)
  }
  return (
    <div ref={box} className="min-w-48" data-testid="table-cell-editing" onKeyDown={onKeyDown}>
      {field.type === "select" ? (
        <select className={NATIVE_CLASS} value={typeof draft === "string" ? draft : ""} aria-label={field.label}
          onChange={(e) => void commit(e.target.value || null)}>
          <option value="">— Không chọn —</option>
          {(field.options.choices ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      ) : field.type === "date" ? (
        <input type="date" className={NATIVE_CLASS} aria-label={field.label} value={typeof draft === "string" ? draft : ""} onChange={(e) => setDraft(e.target.value || undefined)} />
      ) : field.type === "datetime" ? (
        <input type="datetime-local" className={NATIVE_CLASS} aria-label={field.label} value={isoToVnLocal(draft)} onChange={(e) => setDraft(vnLocalToIso(e.target.value))} />
      ) : (
        <CustomFieldInput field={field} value={draft} labels={record.relations[field.key]}
          onChange={(v) => { setDraft(v); if (COMMIT_ON_CHANGE.has(field.type)) void commit(v) }} />
      )}
    </div>
  )
}
