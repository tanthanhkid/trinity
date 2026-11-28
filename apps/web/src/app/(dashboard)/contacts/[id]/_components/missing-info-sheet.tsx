"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AxField } from "@/components/ui/field"
import { BottomSheet, BottomSheetClose, BottomSheetContent, BottomSheetFooter } from "@/components/ui/bottom-sheet"
import { cn } from "@/lib/utils"
import { formatBirthday } from "@/lib/format"
import { birthdayDisplayToIso, birthdayIsoToDisplay, formatBirthdayInput } from "@/lib/birthday-format"
import { useContactPatch, type ContactPatch } from "./use-contact-patch"
import { missingCount } from "./info-panel"
import type { ContactData } from "./contact-info-form"

const GENDERS = [
  { value: "nu", label: "Nữ" },
  { value: "nam", label: "Nam" },
]
const JOB_SUGGESTIONS = ["Kế toán", "Nội trợ", "Kinh doanh", "Nhân viên văn phòng"]

interface Props {
  contact: ContactData
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * «Bổ sung thông tin» trên điện thoại (khach-mobile2): ngày sinh, giới tính, nghề nghiệp, công ty, SĐT phụ.
 * Ô nào chưa biết cứ để trống; «Lưu» chỉ gửi các ô đã đổi, MỘT lần, kèm toast Hoàn tác.
 */
export function MissingInfoSheet({ contact, open, onOpenChange }: Props) {
  const missing = missingCount(contact)
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent title="Bổ sung thông tin" description={missing > 0 ? `${contact.full_name || "Khách"} còn thiếu ${missing} thông tin. Ô nào chưa biết cứ để trống.` : "Cập nhật thông tin của khách."}>
        <MissingInfoForm contact={contact} onDone={() => onOpenChange(false)} />
      </BottomSheetContent>
    </BottomSheet>
  )
}

/** Dựng lúc khay mở (nội dung khay chỉ mount khi mở) ⇒ nạp ô từ khách MỚI NHẤT, không cần effect. */
function MissingInfoForm({ contact, onDone }: { contact: ContactData; onDone: () => void }) {
  const patch = useContactPatch(contact.id)
  const [dob, setDob] = useState(() => birthdayIsoToDisplay(formatBirthday(contact.birthday)))
  const [gender, setGender] = useState(contact.gender ?? "")
  const [job, setJob] = useState(contact.job_title ?? "")
  const [company, setCompany] = useState(contact.company_name ?? "")
  const [phone2, setPhone2] = useState(contact.phone_2 ?? "")
  const [dobError, setDobError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const next: ContactPatch = {}
    const prev: ContactPatch = {}
    const diff = (key: string, value: string, old: string | null | undefined, sendValue: string = value) => {
      const o = old ?? ""
      if (value.trim() === o) return
      next[key] = value.trim() === "" ? null : sendValue.trim()
      prev[key] = o === "" ? null : o
    }
    const dobIso = dob.trim() ? birthdayDisplayToIso(dob.trim()) : ""
    if (dob.trim() && !dobIso) {
      setDobError("Ngày sinh theo dạng ngày/tháng/năm, vd 15/03/1990")
      return
    }
    const oldDobIso = formatBirthday(contact.birthday)
    if (dobIso !== oldDobIso) { next.birthday = dobIso || null; prev.birthday = oldDobIso || null }
    diff("gender", gender, contact.gender)
    diff("job_title", job, contact.job_title)
    diff("company_name", company, contact.company_name)
    diff("phone_2", phone2, contact.phone_2)
    if (Object.keys(next).length === 0) { onDone(); return }
    setSaving(true)
    const ok = await patch(`Đã lưu ${Object.keys(next).length} thông tin`, next, prev)
    setSaving(false)
    if (ok) onDone()
  }

  return (
    <>
        <div className="flex flex-col gap-4 pt-1">
          <AxField
            label="Ngày sinh"
            inputMode="numeric"
            placeholder="dd/mm/yyyy"
            value={dob}
            onChange={(e) => { setDob(formatBirthdayInput(e.target.value)); setDobError(null) }}
            error={dobError ?? undefined}
            hint="Hệ thống nhắc chúc mừng sinh nhật."
          />
          <div>
            <div id="sheet-gender" className="mb-1.5 text-sm font-medium">Giới tính</div>
            <div role="radiogroup" aria-labelledby="sheet-gender" className="grid grid-cols-2 gap-2">
              {GENDERS.map((g) => {
                const on = gender === g.value
                return (
                  <button
                    key={g.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setGender(on ? "" : g.value)}
                    className={cn(
                      "h-12 rounded-ax-field border text-base font-semibold outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
                      on ? "border-ax-primary ax-grad-soft text-ax-primary-ink" : "border-ax-line bg-ax-surface text-ax-ink-2",
                    )}
                  >
                    {g.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <AxField label="Nghề nghiệp" placeholder="Ví dụ: kế toán" value={job} onChange={(e) => setJob(e.target.value)} />
            <div className="mt-2 flex flex-wrap gap-2">
              {JOB_SUGGESTIONS.map((j) => (
                <button
                  key={j}
                  type="button"
                  onClick={() => setJob(j)}
                  className="h-11 rounded-full border border-ax-line bg-ax-surface px-3.5 text-[15px] text-ax-ink-2 outline-none focus-visible:shadow-[var(--ax-focus-ring)]"
                >
                  {j}
                </button>
              ))}
            </div>
          </div>
          <AxField label="Công ty" placeholder="Tên công ty" value={company} onChange={(e) => setCompany(e.target.value)} />
          <AxField label="SĐT phụ" inputMode="tel" placeholder="0901 234 567" value={phone2} onChange={(e) => setPhone2(e.target.value)} />
        </div>
        <BottomSheetFooter>
          <BottomSheetClose render={<Button variant="ax-secondary" size="ax-lg" type="button" />}>Huỷ</BottomSheetClose>
          <Button variant="ax-primary" size="ax-lg" className="flex-1" onClick={save} disabled={saving}>
            {saving ? "Đang lưu…" : "Lưu"}
          </Button>
        </BottomSheetFooter>
    </>
  )
}
