"use client"

import { useEffect, useRef, useState } from "react"
import { Phone, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { HeroCard, HeroCardLabel, HeroCardValue } from "@/components/ui/hero-card"
import { usePermissions } from "@/lib/rbac"
import { useContactPatch } from "./use-contact-patch"
import { PersonAvatar } from "@/components/ui/avatar"
import { formatPhone } from "@/lib/format"
import { buildZaloDirectUrl, cleanPhone, isMaskedPhone } from "@/lib/zalo"

interface Props {
  /** Có `contactId` ⇒ khách chưa có SĐT hiện nút «+ Thêm số điện thoại» (sửa tại chỗ) cho người có quyền. */
  contactId?: number | string
  name: string | null
  phone: string
  code?: string | null
  avatarUrl?: string | null
  sourceLabel?: string | null
  /** Desktop: có hàng nút Gọi / Zalo ngay trên khối. Điện thoại: nút nằm ở thanh đáy (`ContactCallBar`). */
  withActions?: boolean
}

/** Gọi thẳng `tel:` — số bị BE che (`0900***001`) thì chặn như nút Zalo. */
export function callPhone(phone: string) {
  const trimmed = phone.trim()
  if (isMaskedPhone(trimmed)) {
    toast.error("Bạn không có quyền xem số này để gọi")
    return
  }
  window.location.href = `tel:${cleanPhone(trimmed)}`
}

export function openZalo(phone: string) {
  const trimmed = phone.trim()
  if (isMaskedPhone(trimmed)) {
    toast.error("Bạn không có quyền xem số này để nhắn tin")
    return
  }
  window.open(buildZaloDirectUrl(trimmed), "_blank", "noopener")
}

/**
 * Khối nhấn duy nhất của màn: avatar khách (bo 30%) + tên + mã · nguồn + SĐT lớn.
 * SĐT hiển thị đúng chuỗi BE trả (BE che theo `contacts.phone_full`) — FE không tự che theo vai trò.
 */
export function ContactHero({ contactId, name, phone, code, avatarUrl, sourceLabel, withActions }: Props) {
  const display = name || formatPhone(phone)
  const sub = [code, sourceLabel ? `khách từ ${sourceLabel}` : null].filter(Boolean).join(" · ")
  const hasPhone = phone.trim().length > 0
  const { can } = usePermissions()
  // Sửa SĐT cần `contacts.update` + `contacts.phone_full` (BE kiểm phạm vi thật, `PATCH /contacts/:id`).
  const canEditPhone = contactId != null && can("contacts.update") && can("contacts.phone_full")
  return (
    <HeroCard aria-label="Thông tin chính" className="flex flex-col gap-4 max-sm:p-4 lg:rounded-[14px] lg:p-5">
      <div className="flex items-center gap-3.5">
        <PersonAvatar kind="customer" name={display} src={avatarUrl} size="2xl" className="shadow-[var(--ax-shadow-avatar)] max-sm:size-12" />
        <div className="min-w-0">
          <h1 className="break-words text-[22px] leading-tight font-bold tracking-[-0.02em] text-white">{display}</h1>
          {sub ? <div className="mt-0.5 truncate text-sm text-[var(--ax-on-hero-ink-2)]">{sub}</div> : null}
        </div>
      </div>
      <div>
        <HeroCardLabel className="mb-1 text-xs">Số điện thoại</HeroCardLabel>
        {canEditPhone ? (
          <HeroPhoneEditor contactId={contactId} phone={phone} allowReedit={!!withActions} />
        ) : (
          <HeroCardValue className="text-[28px] max-sm:text-[32px]">{hasPhone ? formatPhone(phone) : "—"}</HeroCardValue>
        )}
      </div>
      {withActions && hasPhone ? (
        <div className="grid grid-cols-[1.1fr_1fr] gap-2">
          <Button variant="ax-on-hero" size="ax-lg" onClick={() => callPhone(phone)}>
            <Phone className="size-4" aria-hidden /> Gọi
          </Button>
          <Button variant="ax-on-hero-secondary" size="ax-lg" onClick={() => openZalo(phone)}>
            Zalo
          </Button>
        </div>
      ) : null}
    </HeroCard>
  )
}

/**
 * SĐT trên khối nhấn khi người xem sửa được: chưa có số ⇒ nút «+ Thêm số điện thoại» (viền đứt, ≥ 44 px) mở ô nhập tại chỗ;
 * Enter/rời ô lưu qua `PATCH /contacts/:id`, Esc huỷ. Lưu xong chỉ toast «Đã lưu» (KHÔNG Hoàn tác — chốt 28/11), số mới
 * hiện ngay và (desktop, `allowReedit`) bấm vào số để sửa lại. Lỗi máy chủ (trùng số, sai định dạng) hiện dưới ô, giữ chữ đã gõ.
 */
function HeroPhoneEditor({ contactId, phone, allowReedit }: { contactId: number | string; phone: string; allowReedit: boolean }) {
  const hasPhone = phone.trim().length > 0
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const patch = useContactPatch(contactId)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const start = () => {
    done.current = false
    setError(null)
    setEditing(true)
  }

  const commit = async (raw: string) => {
    if (done.current) return
    done.current = true
    const next = raw.trim()
    if (next === "" || next === phone.trim()) {
      setEditing(false)
      return
    }
    setSaving(true)
    const ok = await patch("Đã lưu", { phone: next }, null, (msg) => setError(msg))
    setSaving(false)
    if (ok) setEditing(false)
    else done.current = false
  }

  if (editing) {
    return (
      <div>
        <input
          ref={inputRef}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          aria-label="Số điện thoại"
          aria-invalid={error ? true : undefined}
          aria-describedby="hero-phone-hint"
          placeholder="Nhập số điện thoại"
          defaultValue={phone}
          disabled={saving}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void commit(e.currentTarget.value)
            }
            if (e.key === "Escape") {
              done.current = true
              setEditing(false)
            }
          }}
          onBlur={(e) => void commit(e.currentTarget.value)}
          className="ax-amount box-border h-12 w-full rounded-[var(--ax-radius-field)] border border-[var(--ax-on-hero-secondary-border)] bg-[var(--ax-on-hero-secondary)] px-3.5 text-[22px] font-bold text-white outline-none placeholder:text-[var(--ax-on-hero-ink-2)] focus-visible:shadow-[var(--ax-focus-ring)]"
        />
        <div id="hero-phone-hint" role={error ? "alert" : undefined} className="mt-1.5 text-[13px] text-[var(--ax-on-hero-ink-2)]">
          {error ?? (saving ? "Đang lưu…" : "Enter lưu · Esc huỷ")}
        </div>
      </div>
    )
  }

  if (!hasPhone) {
    return (
      <Button
        variant="ax-on-hero-secondary"
        size="ax-lg"
        onClick={start}
        className="mt-1 border-[1.5px] border-dashed border-white/70 px-4 text-base"
      >
        <Plus className="size-4" aria-hidden /> Thêm số điện thoại
      </Button>
    )
  }

  return allowReedit ? (
    <button
      type="button"
      onClick={start}
      aria-label="Sửa số điện thoại"
      className="-mx-2 block min-h-11 cursor-text rounded-[var(--ax-radius-field)] px-2 text-left outline-none transition-colors hover:bg-white/10 focus-visible:shadow-[var(--ax-focus-ring)]"
    >
      <span className="ax-amount block text-[28px] leading-[1.1] font-bold text-white">{formatPhone(phone)}</span>
    </button>
  ) : (
    <HeroCardValue className="text-[28px] max-sm:text-[32px]">{formatPhone(phone)}</HeroCardValue>
  )
}
