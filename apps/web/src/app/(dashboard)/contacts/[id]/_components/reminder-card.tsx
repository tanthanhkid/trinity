"use client"

import { useContactPatch } from "./use-contact-patch"
import { usePermissions } from "@/lib/rbac"
import { formatDateTime } from "@/lib/format"
import { MentionText } from "@/components/refs/mention-text"
import { cn } from "@/lib/utils"
import type { ContactData } from "./contact-info-form"

interface Preset { label: string; at: Date }

/** Ba mốc nhanh của thiết kế: chiều nay 16:00 (nếu còn), sáng mai 09:00, thứ Hai tới 09:00. Theo giờ máy người dùng. */
export function reminderPresets(now: Date = new Date()): Preset[] {
  const at = (d: Date, h: number) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x }
  const list: Preset[] = []
  const today16 = at(now, 16)
  if (today16.getTime() > now.getTime()) list.push({ label: "Chiều nay 16:00", at: today16 })
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  list.push({ label: "Sáng mai 09:00", at: at(tomorrow, 9) })
  const monday = new Date(now)
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7))
  if (monday.toDateString() !== tomorrow.toDateString()) list.push({ label: "Thứ Hai 09:00", at: at(monday, 9) })
  return list
}

/** Hẹn gọi lại: chưa hẹn ⇒ 3 mốc nhanh; đã hẹn ⇒ hiện giờ hẹn + «Bỏ». Lưu `reminder_at` ngay, có Hoàn tác. */
export function ReminderCard({ contact, className }: { contact: ContactData; className?: string }) {
  const patch = useContactPatch(contact.id)
  const { can } = usePermissions()
  const editable = can("contacts.update")
  const current = contact.reminder_at

  const set = (iso: string | null, message: string) =>
    patch(message, { reminder_at: iso }, { reminder_at: current ?? null })

  return (
    <section aria-labelledby="contact-reminder" className={cn("ax-card flex flex-col gap-2.5 px-5 py-[18px]", className)}>
      <h2 id="contact-reminder" className="text-sm font-bold tracking-[-0.011em]">Hẹn gọi lại</h2>
      {current ? (
        <div className="flex items-center justify-between gap-2 rounded-[10px] bg-ax-primary-soft px-3 py-2.5">
          <span className="text-sm font-semibold text-ax-primary-ink">{formatDateTime(current)}</span>
          {editable ? (
            <button
              type="button"
              onClick={() => set(null, "Đã bỏ hẹn gọi lại")}
              className="h-10 rounded-ax-field px-2.5 text-sm text-ax-primary-ink underline outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)] max-sm:h-11"
            >
              Bỏ
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <p className="ax-grad-empty rounded-ax-field px-2 py-3.5 text-sm leading-normal text-ax-ink-2">
            Chưa hẹn. Khách mới nên được gọi trong 24 giờ.
          </p>
          {editable ? (
            <div className="flex flex-wrap gap-1.5">
              {reminderPresets().map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => set(p.at.toISOString(), `Đã hẹn gọi lại ${p.label.toLowerCase()}`)}
                  className="h-10 rounded-full border border-ax-line bg-ax-surface px-3.5 text-sm text-ax-ink-2 outline-none transition-colors hover:border-ax-primary hover:text-ax-primary-ink focus-visible:shadow-[var(--ax-focus-ring)] max-sm:h-11"
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {contact.reminder_notes ? (
        <p className="text-sm text-ax-ink-2"><MentionText text={contact.reminder_notes} /></p>
      ) : null}
    </section>
  )
}
