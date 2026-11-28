"use client"

import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { usePermissions } from "@/lib/rbac"
import { formatBirthday, formatDateTimeVn, formatEmployee } from "@/lib/format"
import { birthdayDisplayToIso, birthdayIsoToDisplay, formatBirthdayInput } from "@/lib/birthday-format"
import { useContactPatch } from "./use-contact-patch"
import type { ContactData } from "./contact-info-form"

type TextKey = "email" | "phone_2" | "current_address" | "birthday" | "job_title" | "company_name"

interface FieldMeta {
  key: TextKey
  label: string
  placeholder: string
  inputMode?: "tel" | "email" | "numeric" | "text"
  type?: string
}

/** Các trường sửa tại chỗ (thứ tự của thiết kế). Giới tính, nguồn, người tạo, họ tên (quản trị)… sửa ở form đầy đủ. */
export const INLINE_FIELDS: readonly FieldMeta[] = [
  { key: "email", label: "Email", placeholder: "ten@congty.vn", inputMode: "email", type: "email" },
  { key: "phone_2", label: "SĐT phụ", placeholder: "Số thứ hai", inputMode: "tel", type: "tel" },
  { key: "current_address", label: "Địa chỉ", placeholder: "Phường/xã, tỉnh/thành" },
  { key: "birthday", label: "Ngày sinh", placeholder: "dd/mm/yyyy", inputMode: "numeric" },
  { key: "job_title", label: "Nghề nghiệp", placeholder: "Ví dụ: kế toán" },
  { key: "company_name", label: "Công ty", placeholder: "Tên công ty" },
]

/** Giá trị hiển thị của trường (rỗng = chưa có). */
export function fieldDisplay(key: TextKey, c: ContactData): string {
  // Theo chuỗi ngày BE (yyyy-mm-dd), không qua múi giờ — cùng cách form đầy đủ đọc ngày sinh.
  if (key === "birthday") return birthdayIsoToDisplay(formatBirthday(c.birthday))
  return (c[key] as string | null | undefined) ?? ""
}

/** Số trường chưa điền trong bộ «bổ sung» (ngày sinh, giới tính, nghề, công ty, SĐT phụ) — dòng nhắc ở điện thoại. */
export const MISSING_KEYS = ["birthday", "gender", "job_title", "company_name", "phone_2"] as const
export function missingCount(c: ContactData): number {
  return MISSING_KEYS.filter((k) => !((c[k] as string | null | undefined) ?? "").toString().trim()).length
}

function InlineField({ meta, contact, editable, startEditing = false, onClosed }: { meta: FieldMeta; contact: ContactData; editable: boolean; startEditing?: boolean; onClosed?: () => void }) {
  const [editing, setEditingRaw] = useState(startEditing)
  const setEditing = (v: boolean) => { setEditingRaw(v); if (!v) onClosed?.() }
  const [error, setError] = useState<string | null>(null)
  const patch = useContactPatch(contact.id)
  const done = useRef(false)
  const current = fieldDisplay(meta.key, contact)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = `contact-field-${meta.key}`

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const start = () => { done.current = false; setError(null); setEditing(true) }

  const commit = async (raw: string) => {
    if (done.current) return
    done.current = true
    const next = raw.trim()
    if (next === current) { setEditing(false); return }
    let value: string | null = next === "" ? null : next
    let prev: string | null = current === "" ? null : current
    if (meta.key === "birthday") {
      const iso = next === "" ? "" : birthdayDisplayToIso(next)
      if (next !== "" && !iso) {
        done.current = false
        setError("Ngày sinh theo dạng ngày/tháng/năm, vd 15/03/1990")
        return
      }
      value = iso || null
      prev = formatBirthday(contact.birthday) || null
    }
    setEditing(false)
    await patch(`Đã lưu ${meta.label.toLowerCase()}`, { [meta.key]: value }, { [meta.key]: prev })
  }

  if (editing) {
    return (
      <div className="py-1.5">
        <label htmlFor={id} className="mb-1.5 block text-xs font-semibold text-ax-primary">{meta.label}</label>
        <Input
          ref={inputRef}
          id={id}
          variant="ax"
          type={meta.type ?? "text"}
          inputMode={meta.inputMode}
          placeholder={meta.placeholder}
          defaultValue={current}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={meta.key === "birthday" ? (e) => { e.target.value = formatBirthdayInput(e.target.value) } : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commit(e.currentTarget.value) }
            if (e.key === "Escape") { done.current = true; setEditing(false) }
          }}
          onBlur={(e) => void commit(e.currentTarget.value)}
        />
        <div id={`${id}-hint`} role={error ? "alert" : undefined} className={cn("mt-1.5 text-xs", error ? "text-ax-danger" : "text-ax-ink-3")}>
          {error ?? "Enter lưu · Esc huỷ"}
        </div>
      </div>
    )
  }

  const body = (
    <>
      <span className="text-xs text-ax-ink-3">{meta.label}</span>
      <span className="ax-amount text-[15px] font-medium break-words">{current}</span>
    </>
  )
  return editable ? (
    <button
      type="button"
      onClick={start}
      aria-label={`Sửa ${meta.label}`}
      className="-mx-2.5 flex min-h-12 w-[calc(100%+20px)] cursor-text flex-col gap-0.5 rounded-ax-field px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]"
    >
      {body}
    </button>
  ) : (
    <div className="flex min-h-12 flex-col gap-0.5 py-1.5">{body}</div>
  )
}

/** Dòng chỉ đọc (người phụ trách, người tạo… — không sửa tại chỗ). */
function StaticRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex min-h-12 flex-col gap-0.5 py-1.5">
      <span className="text-xs text-ax-ink-3">{label}</span>
      <span className="text-[15px] font-medium break-words">{value}</span>
    </div>
  )
}

interface PanelProps {
  contact: ContactData
  assigneeName: string | null
  assigneeEmail: string | null
  creatorName: string | null
  createdAt: string | null
  /** Mở form đầy đủ (giới tính, nguồn, họ tên, ghi chú nhắc…). */
  onOpenFullForm?: () => void
  className?: string
}

/**
 * Cột «Thông tin» (desktop): trường có giá trị bấm để sửa tại chỗ (Enter lưu · Esc huỷ · rời ô cũng lưu),
 * trường trống thành chip «+ Nhãn» dưới cùng. Mỗi lần lưu có toast Hoàn tác.
 */
export function ContactInfoPanel({ contact, assigneeName, assigneeEmail, creatorName, createdAt, onOpenFullForm, className }: PanelProps) {
  const { can } = usePermissions()
  const editable = can("contacts.update")
  const [adding, setAdding] = useState<TextKey | null>(null)
  const filled = INLINE_FIELDS.filter((f) => fieldDisplay(f.key, contact) !== "" || adding === f.key)
  const empties = INLINE_FIELDS.filter((f) => fieldDisplay(f.key, contact) === "" && adding !== f.key)

  return (
    <aside aria-labelledby="contact-info-h" className={cn("ax-card flex flex-col gap-1.5 px-5 py-[18px]", className)}>
      <h2 id="contact-info-h" className="mb-1 text-sm font-bold tracking-[-0.011em]">Thông tin</h2>
      {filled.map((f) => (
        <InlineField key={f.key} meta={f} contact={contact} editable={editable} startEditing={adding === f.key} onClosed={() => setAdding((a) => (a === f.key ? null : a))} />
      ))}
      {editable && empties.length > 0 ? (
        <div className="mt-2 border-t border-ax-divider pt-3">
          <div className="mb-2 text-xs text-ax-ink-3">Thêm thông tin</div>
          <div className="flex flex-wrap gap-1.5">
            {empties.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setAdding(f.key)}
                className="h-10 rounded-full border border-dashed border-ax-field-border bg-ax-surface px-3.5 text-sm text-ax-ink-2 outline-none transition-colors hover:border-ax-primary hover:text-ax-primary-ink focus-visible:shadow-[var(--ax-focus-ring)]"
              >
                + {f.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-2 border-t border-ax-divider pt-2">
        <StaticRow label="Phụ trách" value={assigneeName ? formatEmployee({ email: assigneeEmail, full_name: assigneeName }) : null} />
        <StaticRow label="Giới tính" value={contact.gender === "nam" ? "Nam" : contact.gender === "nu" ? "Nữ" : null} />
        <StaticRow label="Trạng thái chi tiết" value={contact.contact_status?.label} />
        <StaticRow label="Người tạo" value={creatorName} />
      </div>
      {onOpenFullForm && editable ? (
        <button
          type="button"
          onClick={onOpenFullForm}
          className="mt-1 h-10 self-start rounded-ax-field px-2.5 text-sm font-semibold text-ax-primary-ink outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]"
        >
          Chỉnh sửa đầy đủ
        </button>
      ) : null}
      <p className="ax-sunken mt-3 rounded-ax-field px-3 py-2.5 text-xs leading-normal text-ax-ink-2 shadow-ax-inset">
        {createdAt ? `Tạo lúc ${formatDateTimeVn(createdAt)} · ` : ""}Hệ thống ghi mọi thay đổi vào Lịch sử
      </p>
    </aside>
  )
}
