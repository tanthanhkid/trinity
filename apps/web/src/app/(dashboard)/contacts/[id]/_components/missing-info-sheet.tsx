"use client"

import { useState } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { AxField } from "@/components/ui/field"
import { HeroCard } from "@/components/ui/hero-card"
import { cn } from "@/lib/utils"
import { formatBirthday } from "@/lib/format"
import { CONTACT_GENDERS } from "@/lib/contact-gender"
import { birthdayDisplayToIso, birthdayIsoToDisplay, formatBirthdayInput } from "@/lib/birthday-format"
import { useContactPatch, type ContactPatch } from "./use-contact-patch"
import { MISSING_KEYS, missingCount } from "./info-panel"
import type { ContactData } from "./contact-info-form"

const JOB_SUGGESTIONS = ["Kế toán", "Nội trợ", "Chủ shop", "Giáo viên"]

interface Props {
  contact: ContactData
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * «Bổ sung thông tin» trên điện thoại (khach-mobile2): màn TOÀN PHẦN phủ cả thanh đầu app — đầu trang Huỷ · tiêu đề ·
 * «Lưu (n)», khối nhấn «<tên> còn thiếu n thông tin», rồi ngày sinh, giới tính (Nữ/Nam/Khác), nghề nghiệp, công ty, SĐT phụ.
 * Dựng trên Dialog của Base UI ⇒ khoá focus, Esc đóng, trả focus về nút mở. Ô nào chưa biết cứ để trống; «Lưu» chỉ gửi các
 * ô đã đổi, MỘT lần `PATCH /contacts/:id`, kèm toast Hoàn tác.
 */
export function MissingInfoScreen({ contact, open, onOpenChange }: Props) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          data-slot="missing-info-screen"
          className="fixed inset-0 z-50 flex flex-col ax-page text-ax-ink outline-none transition-transform duration-200 ease-out data-ending-style:translate-y-full data-starting-style:translate-y-full"
        >
          <MissingInfoForm contact={contact} onDone={() => onOpenChange(false)} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** Dựng lúc mở (nội dung chỉ mount khi mở) ⇒ nạp ô từ khách MỚI NHẤT, không cần effect. */
function MissingInfoForm({ contact, onDone }: { contact: ContactData; onDone: () => void }) {
  const patch = useContactPatch(contact.id)
  const [dob, setDob] = useState(() => birthdayIsoToDisplay(formatBirthday(contact.birthday)))
  const [gender, setGender] = useState(contact.gender ?? "")
  const [job, setJob] = useState(contact.job_title ?? "")
  const [company, setCompany] = useState(contact.company_name ?? "")
  const [phone2, setPhone2] = useState(contact.phone_2 ?? "")
  const [dobError, setDobError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const missing = missingCount(contact)
  const name = contact.full_name || "Khách"
  // Số ô đã đổi so với hồ sơ — nút «Lưu (n)» chỉ sáng khi có thay đổi.
  const draft: Record<(typeof MISSING_KEYS)[number], string> = {
    birthday: dob, gender, job_title: job, company_name: company, phone_2: phone2,
  }
  const original: Record<(typeof MISSING_KEYS)[number], string> = {
    birthday: birthdayIsoToDisplay(formatBirthday(contact.birthday)),
    gender: contact.gender ?? "",
    job_title: contact.job_title ?? "",
    company_name: contact.company_name ?? "",
    phone_2: contact.phone_2 ?? "",
  }
  const changed = MISSING_KEYS.filter((k) => draft[k].trim() !== original[k].trim()).length

  const save = async () => {
    const next: ContactPatch = {}
    const prev: ContactPatch = {}
    const diff = (key: string, value: string, old: string | null | undefined) => {
      const o = old ?? ""
      if (value.trim() === o) return
      next[key] = value.trim() === "" ? null : value.trim()
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
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-ax-line ax-grad-bar px-2">
        <DialogPrimitive.Close
          className="h-11 rounded-ax-field px-3 text-base text-ax-ink-2 outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]"
        >
          Huỷ
        </DialogPrimitive.Close>
        <DialogPrimitive.Title className="text-[17px] font-bold tracking-[-0.011em]">Bổ sung thông tin</DialogPrimitive.Title>
        <button
          type="button"
          onClick={save}
          disabled={saving || changed === 0}
          className={cn(
            "h-11 rounded-ax-field px-3 text-base font-bold outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)] disabled:hover:bg-transparent",
            changed > 0 ? "text-ax-primary" : "text-ax-ink-3",
          )}
        >
          {saving ? "Đang lưu…" : changed > 0 ? `Lưu (${changed})` : "Lưu"}
        </button>
      </header>
      <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto overscroll-contain px-4 pt-4 pb-[calc(40px+env(safe-area-inset-bottom))] [&_[data-slot=ax-field]>label]:text-sm [&_[data-slot=ax-field]>label]:font-semibold [&_[data-slot=ax-field]>label]:text-foreground">
        <HeroCard compact className="rounded-[16px] px-[18px] py-4">
          <DialogPrimitive.Description className="text-sm leading-normal">
            <strong className="mb-0.5 block text-[17px] font-semibold tracking-[-0.011em] text-white">
              {missing > 0 ? `${name} còn thiếu ${missing} thông tin` : `Cập nhật thông tin của ${name}`}
            </strong>
            <span className="text-[var(--ax-on-hero-ink-2)]">Điền được ô nào thì điền, ô nào chưa biết cứ để trống.</span>
          </DialogPrimitive.Description>
        </HeroCard>
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
          <div id="screen-gender" className="mb-1.5 text-sm font-semibold">Giới tính</div>
          <div role="radiogroup" aria-labelledby="screen-gender" className="grid grid-cols-3 gap-2">
            {CONTACT_GENDERS.map((g) => {
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
    </>
  )
}
