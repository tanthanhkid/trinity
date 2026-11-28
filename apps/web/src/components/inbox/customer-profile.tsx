"use client"

/* =============================================================================
 * Hồ sơ khách ngay cạnh hội thoại (hopthu-desktop / hopthu-mobile «Ánh xanh»).
 *   desktop ≥1280px: cột phải — khối nhấn (avatar, tên, giai đoạn · phụ trách) + giai đoạn + trường + hẹn nhắc
 *   điện thoại / desktop hẹp: cùng nội dung trong khay đáy «Hồ sơ khách»
 * Sửa tại chỗ rồi LƯU NGAY + toast «Hoàn tác». Dữ liệu và ghi dùng ĐÚNG API màn chi tiết khách:
 * GET/PATCH /contacts/:id (khoá cache ["contact", id] dùng chung).
 * ========================================================================== */

import { useState, type ReactNode } from "react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
import { errorMessage } from "@/lib/error-messages"
import { formatDateTimeVn, formatPhone, vnDateKey } from "@/lib/format"
import { usePermissions } from "@/lib/rbac"
import { useSettingsOptions } from "@/hooks/use-settings-options"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AxField } from "@/components/ui/field"
import { PersonAvatar } from "@/components/ui/avatar"
import { HeroCard } from "@/components/ui/hero-card"
import { StageChip, type StageTone } from "@/components/ui/stage-chip"
import { showUndoToast } from "@/components/ui/undo-toast"
import { BottomSheet, BottomSheetClose, BottomSheetContent } from "@/components/ui/bottom-sheet"
import { HeroChip } from "@/components/inbox/inbox-ui"
import type { ContactData } from "@/app/(dashboard)/contacts/[id]/_components/contact-info-form"

/** Khách đã ghép với hội thoại: bản ghi chi tiết khách + vài trường BE trả thêm (người phụ trách, ngày tạo). */
export type LinkedContact = Partial<ContactData> & {
  assigned_user?: { full_name?: string | null } | null
  created_at?: string | null
}

/** Cùng truy vấn với màn chi tiết khách `["contact", id]` — chỉ khi có quyền xem khách. */
export function useLinkedContact(contactId: number | null, enabled: boolean) {
  return useQuery<LinkedContact>({
    queryKey: ["contact", String(contactId)],
    enabled: enabled && contactId !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => (await apiClient.get<LinkedContact>(`/contacts/${contactId}`)).data,
  })
}

/** Giai đoạn theo mã BỀN của nhóm `contact_stage` → tông của hệ thiết kế; mã lạ (tuỳ biến) = trung tính. */
export function stageToneOf(value: string | null | undefined): StageTone {
  switch (value) {
    case "new": return "new"
    case "follow_up_2": return "consult"
    case "follow_up_3": return "quote"
    case "won": return "won"
    default: return "neutral"
  }
}

const VN_OFFSET = "+07:00"
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const at = (key: string, hm: string) => new Date(`${key}T${hm}:00${VN_OFFSET}`)

/** Mốc hẹn nhắc nhanh theo thiết kế: hôm nay 17:00 (nếu chưa qua) · sáng mai 09:00 · thứ Hai tới 09:00. */
export function reminderPresets(now: Date = new Date()): { label: string; at: Date }[] {
  const today = vnDateKey(now)
  const out: { label: string; at: Date }[] = []
  const t17 = at(today, "17:00")
  if (t17.getTime() > now.getTime()) out.push({ label: "Hôm nay 17:00", at: t17 })
  out.push({ label: "Sáng mai 09:00", at: at(addDays(today, 1), "09:00") })
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() // 0 = CN
  const toMon = ((8 - dow) % 7) || 7
  const mon = addDays(today, toMon)
  const [, m, d] = mon.split("-")
  out.push({ label: `Thứ Hai ${d}/${m} 09:00`, at: at(mon, "09:00") })
  return out
}

/** Dòng tóm tắt hẹn nhắc cho đầu khay / chip: "Chưa đặt hẹn" hoặc giờ hẹn. */
export function reminderText(c: LinkedContact | null | undefined): string {
  return c?.reminder_at ? formatDateTimeVn(c.reminder_at) : "Chưa đặt hẹn"
}

/** Dòng phụ đầu hội thoại trên điện thoại (thiết kế hopthu-mobile): «Kênh · Phụ trách …»; chưa có người phụ trách thì chỉ kênh. */
export function threadMobileSub(channelLabel: string, c: LinkedContact | null | undefined): string {
  const owner = c?.assigned_user?.full_name?.trim()
  return owner ? `${channelLabel} · Phụ trách ${owner}` : channelLabel
}

/**
 * Hàng chip trên khối nhấn đầu hội thoại (điện thoại): SĐT (thiếu ⇒ «Thêm số điện thoại» viền đứt) · giai đoạn · hẹn nhắc.
 * Bấm chip nào cũng mở khay «Hồ sơ khách». Dùng chung cho Zalo OA và Messenger.
 */
export function ProfileChips({ contact, phone, onOpen }: { contact: LinkedContact | null; phone: string | null | undefined; onOpen: () => void }) {
  const stageLabel = contact?.stage_option?.label ?? null
  return (
    <>
      <HeroChip tone={phone ? "solid" : "dashed"} onClick={onOpen}>{phone ? formatPhone(phone) : "Thêm số điện thoại"}</HeroChip>
      {stageLabel ? <HeroChip onClick={onOpen}>{stageLabel}</HeroChip> : null}
      {contact ? <HeroChip tone="glass" onClick={onOpen}>{reminderText(contact)}</HeroChip> : null}
    </>
  )
}

type PatchBody = Record<string, string | number | null>

/**
 * Lưu một trường ngay (PATCH /contacts/:id) rồi hiện toast «Đã lưu …» có Hoàn tác (PATCH lại giá trị cũ).
 * Giá trị cũ rỗng mà BE không cho xoá (giai đoạn, trạng thái chi tiết) ⇒ toast không có Hoàn tác.
 */
function useSaveContact(contactId: number) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (body: PatchBody) => { await apiClient.patch(`/contacts/${contactId}`, body) },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", String(contactId)] })
      void qc.invalidateQueries({ queryKey: ["contacts"] })
    },
    onError: (err) => toast.error(errorMessage(err, "Không thể cập nhật thông tin")),
  })
  const save = (label: string, next: PatchBody, undo: PatchBody | null) =>
    mutation.mutate(next, {
      onSuccess: () => showUndoToast(`Đã lưu ${label}`, { onUndo: undo ? () => mutation.mutate(undo) : undefined }),
    })
  return { save, pending: mutation.isPending }
}

const GROUP_LABEL = "ax-text-group mb-2"

function Row({ label, children, onClick, editLabel }: { label: string; children: ReactNode; onClick?: () => void; editLabel?: string }) {
  const body = (
    <>
      <span className="w-24 shrink-0 text-[13px] text-ax-ink-2 max-lg:w-[108px] max-lg:text-sm">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[15px] max-lg:text-right max-lg:text-base">{children}</span>
    </>
  )
  const cls = "flex min-h-12 w-full items-center gap-3 rounded-[10px] px-2 text-left max-lg:min-h-14 max-lg:rounded-none max-lg:px-0"
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={editLabel} className={cn(cls, "cursor-pointer outline-none transition-colors duration-150 hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]")}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/**
 * Nội dung hồ sơ khách. `variant="panel"` = cột phải desktop (có khối nhấn ở đầu); `"sheet"` = trong khay đáy.
 * Chưa ghép khách trong CRM hoặc thiếu quyền xem khách ⇒ chỉ hiện thông tin có sẵn từ hội thoại (không sửa được).
 */
export function CustomerProfile({
  contactId,
  fallbackName,
  fallbackPhone,
  avatarUrl,
  channelLabel,
  variant = "panel",
}: {
  contactId: number | null
  fallbackName: string
  fallbackPhone?: string | null
  avatarUrl?: string | null
  /** Vd "Zalo OA" — dòng «Nguồn». */
  channelLabel: string
  variant?: "panel" | "sheet"
}) {
  const { can } = usePermissions()
  const canView = can("contacts.view")
  const canUpdate = can("contacts.update")
  const { isAdmin } = usePermissions()
  const q = useLinkedContact(contactId, canView)
  const c: LinkedContact | null = q.data && typeof q.data === "object" ? q.data : null
  const linked = contactId !== null && c !== null
  const sheet = variant === "sheet"
  const { data: stages = [] } = useSettingsOptions("contact_stage")
  const { data: statuses = [] } = useSettingsOptions("contact_detail_status")
  const { save, pending } = useSaveContact(contactId ?? 0)
  const [editing, setEditing] = useState<"name" | "status" | null>(null)
  const [draft, setDraft] = useState("")

  const name = c?.full_name?.trim() || fallbackName
  const phone = c?.phone || fallbackPhone || null
  const stageLabel = c?.stage_option?.label ?? stages.find((s) => s.id === c?.stage_id)?.label ?? null
  const owner = c?.assigned_user?.full_name?.trim() || null
  const edit = linked && canUpdate

  const startName = () => { setDraft(c?.full_name ?? ""); setEditing("name") }
  const commitName = () => {
    const next = draft.trim()
    setEditing(null)
    if (c && next && next !== (c.full_name ?? "").trim()) save("họ tên", { full_name: next }, c.full_name ? { full_name: c.full_name } : null)
  }

  const presets = reminderPresets()
  const remindAt = c?.reminder_at ? Date.parse(c.reminder_at) : null
  const setRemind = (iso: string | null, label: string) => {
    if (!c) return
    save(label, { reminder_at: iso }, { reminder_at: c.reminder_at ?? null })
  }

  const statusLabel = c?.contact_status?.label ?? statuses.find((s) => s.id === c?.contact_status_id)?.label ?? null

  const hero = (
    <HeroCard className="mb-3.5 flex items-center gap-3 rounded-none border-x-0 border-t-0 px-4 py-[18px] max-sm:p-4">
      <PersonAvatar kind="customer" name={name} src={avatarUrl ?? c?.avatar_url ?? undefined} size="xl" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[17px] font-bold tracking-[-0.011em] text-white">{name}</p>
        <p className="truncate text-[13px] text-[var(--ax-on-hero-ink-2)]">
          {[stageLabel, owner ? `Phụ trách ${owner}` : null].filter(Boolean).join(" · ") || channelLabel}
        </p>
      </div>
      {linked && canView ? (
        <Link href={`/contacts/${contactId}`} className="relative shrink-0 text-[13px] font-semibold text-white underline underline-offset-[3px] outline-none hover:text-[#DCE8F3] focus-visible:shadow-[var(--ax-focus-ring)] after:absolute after:-inset-2">
          Hồ sơ đầy đủ
        </Link>
      ) : null}
    </HeroCard>
  )

  if (!linked) {
    return (
      <div className="flex flex-col">
        {!sheet && hero}
        <div className="flex flex-col gap-1 px-4 py-2">
          <Row label="Điện thoại"><span className="ax-amount font-medium text-ax-ink">{formatPhone(phone) || "Chưa có"}</span></Row>
          <p className="px-2 text-[13px] text-ax-ink-2 max-lg:px-0">
            {contactId === null
              ? "Chưa ghép với khách nào trong CRM."
              : canView ? (q.isLoading ? "Đang tải hồ sơ…" : "Không tải được hồ sơ khách.") : `Khách #${contactId} — bạn chưa có quyền xem hồ sơ khách.`}
          </p>
        </div>
        <p className="px-4 pt-3 pb-4 text-[12px] leading-relaxed text-ax-ink-3">Nguồn: {channelLabel}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {!sheet && hero}

      <div className={cn("px-4 pb-3", sheet && "px-0 pt-1.5")}>
        <div id={`st-l-${variant}`} className={GROUP_LABEL}>Giai đoạn</div>
        <div role="group" aria-labelledby={`st-l-${variant}`} className="flex flex-wrap gap-1.5 max-lg:gap-2">
          {stages.map((s) => {
            const on = s.id === c.stage_id
            return (
              <StageChip
                key={s.id}
                tone={stageToneOf(s.value)}
                selected={on}
                disabled={!edit || pending}
                onClick={() => { if (!on) save("giai đoạn", { stage_id: s.id }, c.stage_id ? { stage_id: c.stage_id } : null) }}
                className="h-10 px-3.5 text-sm max-lg:h-11 max-lg:px-4 max-lg:text-[15px]"
              >
                {s.label}
              </StageChip>
            )
          })}
        </div>
      </div>

      <div className={cn("border-t border-ax-divider px-2 pt-2 pb-1", sheet && "mt-3.5 px-0 pt-0")}>
        {/* Số điện thoại: chỉ xem ở đây; lưu SĐT khách nhắn vào hồ sơ = nút dưới bong bóng (`save-phone.tsx`, POST /zalo-oa/threads/:id/save-phone). */}
        <Row label="Số điện thoại">
          <span className={cn("ax-amount", phone ? "font-medium text-ax-ink" : "font-semibold text-ax-primary-ink")}>{formatPhone(phone) || "Chưa có"}</span>
        </Row>

        {editing === "name" ? (
          <div className="flex flex-col gap-1 px-2 py-2 max-lg:px-0">
            <AxField
              label="Họ tên"
              value={draft}
              autoFocus
              placeholder="Tên khách"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditing(null) }}
              onBlur={sheet ? undefined : commitName}
              hint={sheet ? undefined : "Enter để lưu, Esc để bỏ"}
            />
            {sheet && (
              <div className="mt-1 flex gap-2">
                <Button variant="ax-secondary" size="ax-lg" className="flex-1" onClick={() => setEditing(null)}>Huỷ</Button>
                <Button variant="ax-primary" size="ax-lg" className="flex-1" onClick={commitName}>Lưu</Button>
              </div>
            )}
          </div>
        ) : (
          <Row label="Họ tên" onClick={edit && isAdmin ? startName : undefined} editLabel={`Sửa họ tên: ${name}`}>
            <span className="font-medium text-ax-ink">{name}</span>
          </Row>
        )}

        <Row label="Trạng thái chi tiết" onClick={edit && statuses.length > 0 ? () => setEditing(editing === "status" ? null : "status") : undefined} editLabel={`Sửa trạng thái chi tiết: ${statusLabel ?? "chưa có"}`}>
          <span className={statusLabel ? "font-medium text-ax-ink" : "font-semibold text-ax-primary-ink"}>{statusLabel ?? (edit ? "Thêm trạng thái chi tiết" : "Chưa có")}</span>
        </Row>
        {editing === "status" && (
          <div role="group" aria-label="Chọn trạng thái chi tiết" className="flex flex-wrap gap-1.5 px-2 pb-2 max-lg:gap-2 max-lg:px-0">
            {statuses.map((s) => (
              <StageChip
                key={s.id}
                selected={s.id === c.contact_status_id}
                disabled={pending}
                onClick={() => {
                  setEditing(null)
                  if (s.id !== c.contact_status_id) save("trạng thái chi tiết", { contact_status_id: s.id }, c.contact_status_id ? { contact_status_id: c.contact_status_id } : null)
                }}
                className="h-9 px-3 text-sm max-lg:h-11"
              >
                {s.label}
              </StageChip>
            ))}
          </div>
        )}
      </div>

      <div className={cn("border-t border-ax-divider px-4 py-3", sheet && "mt-1 border-t-0 px-0")}>
        <div id={`rm-l-${variant}`} className={GROUP_LABEL}>Hẹn nhắc lại</div>
        <p className={cn("mb-2 text-[15px] font-semibold tracking-[-0.011em]", c.reminder_at ? "text-ax-ink" : "text-ax-ink-2")}>{reminderText(c)}</p>
        {edit ? (
          <div role="group" aria-labelledby={`rm-l-${variant}`} className="flex flex-wrap gap-1.5 max-lg:gap-2">
            {presets.map((r) => (
              <Button
                key={r.label}
                variant="ax-secondary"
                size="ax"
                disabled={pending}
                className={cn("font-medium", remindAt === r.at.getTime() && "text-ax-primary-ink")}
                onClick={() => setRemind(r.at.toISOString(), "hẹn nhắc")}
              >
                {r.label}
              </Button>
            ))}
            {c.reminder_at ? (
              <Button variant="ax-secondary" size="ax" disabled={pending} className="font-medium text-[var(--ax-danger-ink)]" onClick={() => setRemind(null, "hẹn nhắc")}>
                Bỏ hẹn
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className={cn("border-t border-ax-divider px-4 pt-3 pb-4 text-[12px] leading-relaxed text-ax-ink-3", sheet && "mt-3 border-t-0 px-0")}>
        Nguồn: {c.source?.label ?? channelLabel}
        {c.created_at ? <><br />Tạo lúc {formatDateTimeVn(c.created_at)} · Người tạo: {c.creator?.full_name ?? "Hệ thống"}</> : null}
      </p>
    </div>
  )
}

/** Khay đáy «Hồ sơ khách»: nút «Xong» ở đầu, nội dung cuộn. Dùng trên điện thoại và desktop hẹp (<1280px). */
export function ProfileSheet({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent title="Hồ sơ khách" className="h-[min(640px,85dvh)] gap-1">
        <BottomSheetClose
          render={<button type="button" />}
          className="absolute top-2 right-2 h-11 cursor-pointer rounded-[10px] px-3 text-base font-bold tracking-[-0.011em] text-ax-primary outline-none focus-visible:shadow-[var(--ax-focus-ring)]"
        >
          Xong
        </BottomSheetClose>
        {children}
      </BottomSheetContent>
    </BottomSheet>
  )
}
