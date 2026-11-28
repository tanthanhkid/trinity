"use client"

import { Phone } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { HeroCard, HeroCardLabel, HeroCardValue } from "@/components/ui/hero-card"
import { PersonAvatar } from "@/components/ui/avatar"
import { formatPhone } from "@/lib/format"
import { buildZaloDirectUrl, cleanPhone, isMaskedPhone } from "@/lib/zalo"

interface Props {
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
export function ContactHero({ name, phone, code, avatarUrl, sourceLabel, withActions }: Props) {
  const display = name || formatPhone(phone)
  const sub = [code, sourceLabel ? `khách từ ${sourceLabel}` : null].filter(Boolean).join(" · ")
  const hasPhone = phone.trim().length > 0
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
        <HeroCardValue className="text-[28px] max-sm:text-[32px]">{hasPhone ? formatPhone(phone) : "—"}</HeroCardValue>
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
