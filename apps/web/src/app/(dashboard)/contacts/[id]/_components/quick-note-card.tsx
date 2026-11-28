"use client"

import { useId, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import apiClient from "@/lib/api-client"
import { errorMessage } from "@/lib/error-messages"
import { cn } from "@/lib/utils"

/** Trần độ dài của một ghi chú (bằng `NOTE_MAX` của `POST /contacts/:id/notes`). */
export const NOTE_MAX = 2000

/**
 * «Ghi nhanh cuộc gọi» (khach-desktop) / «Ghi nhanh» (khach-mobile): ghi chú vào dòng thời gian của khách qua
 * `POST /contacts/:id/notes` (quyền `contacts.update`, cùng lõi với tool AI «Thêm ghi chú cho khách»). Nút «Lưu ghi chú»
 * nhạt khi ô trống, chuyển nút chính khi có chữ; lưu xong xoá ô và tải lại Lịch sử. Ẩn cả khối khi thiếu quyền (trang gọi
 * bọc `Can`).
 */
export function QuickNoteCard({ contactId, variant }: { contactId: number | string; variant: "desktop" | "mobile" }) {
  const id = String(contactId)
  const fieldId = useId()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const note = draft.trim()
  const ready = note.length > 0 && !saving
  const mobile = variant === "mobile"

  const save = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await apiClient.post(`/contacts/${id}/notes`, { note })
      setDraft("")
      toast.success("Đã lưu ghi chú")
      await queryClient.invalidateQueries({ queryKey: ["contact-activities", id] })
    } catch (err) {
      toast.error(errorMessage(err, "Không thể lưu ghi chú"))
    } finally {
      setSaving(false)
    }
  }

  const button = (
    <Button
      type="button"
      variant={ready ? "ax-primary" : "ax-secondary"}
      size={mobile ? "ax-lg" : "ax"}
      onClick={save}
      disabled={!ready}
      className={cn(
        "disabled:opacity-100",
        !ready && "bg-ax-sunken text-ax-ink-2 shadow-none hover:bg-ax-sunken",
        mobile ? "w-full text-base" : "px-[18px]",
      )}
    >
      {saving ? "Đang lưu…" : "Lưu ghi chú"}
    </Button>
  )

  return (
    <section className={cn("ax-card flex flex-col gap-2.5", mobile ? "px-4 py-3.5" : "px-5 py-[18px]")}>
      <label htmlFor={fieldId} className={cn("font-bold tracking-[-0.011em]", mobile ? "text-[15px]" : "text-sm")}>
        {mobile ? "Ghi nhanh" : "Ghi nhanh cuộc gọi"}
      </label>
      <textarea
        id={fieldId}
        rows={mobile ? 2 : 3}
        value={draft}
        maxLength={NOTE_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Ctrl/⌘ + Enter lưu nhanh khi đang gõ (Enter thường vẫn xuống dòng).
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void save()
          }
        }}
        placeholder={mobile ? "Khách nói gì, hẹn gì…" : "Khách hỏi gì, hẹn gì…"}
        className={cn(
          "box-border w-full rounded-ax-field border border-ax-field-border bg-ax-surface text-ax-ink outline-none placeholder:text-[var(--ax-placeholder)] hover:border-[var(--ax-field-border-hover)] focus-visible:border-ax-primary focus-visible:shadow-[var(--ax-field-focus)]",
          mobile ? "resize-none px-3.5 py-3 text-base leading-[1.45]" : "resize-y px-3 py-2.5 text-[15px] leading-normal",
        )}
      />
      {mobile ? (
        button
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ax-ink-3">Lưu vào dòng thời gian của khách</span>
          {button}
        </div>
      )}
    </section>
  )
}
