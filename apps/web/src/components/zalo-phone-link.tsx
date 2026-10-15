"use client"

import { MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { maskPhone } from "@/lib/format"
import { buildZaloDirectUrl, isMaskedPhone } from "@/lib/zalo"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"

interface ZaloPhoneLinkProps {
  phone: string
  masked?: boolean
  /**
   * Override quyết định che/hiện SĐT — dùng khi màn hình có quyền xem SĐT
   * RIÊNG (vd `contacts.phone_full`). Khi truyền, THẮNG hoàn toàn `masked`.
   * Không truyền → che iff `masked` và viewer KHÔNG có `contacts.phone_full`.
   */
  viewerCanSeeFull?: boolean
  className?: string
}

/**
 * Hiển thị SĐT + icon Zalo. Click mở deeplink Zalo native `https://zalo.me/{phone}`
 * (mobile mở Zalo app).
 *
 * ⚠️ QUYỀN NHẮN = SĐT có bị che hay không, dựa DUY NHẤT vào `isMaskedPhone(phone)`
 * (BE `PhoneMaskInterceptor` là nguồn chân lý: trả số THẬT iff viewer được phép —
 * gồm owner-override cho người phụ trách — che `0900***001` nếu không). KHÔNG tự
 * suy quyền từ quyền xem SĐT ở guard: nó chỉ dùng để CHE HIỂN THỊ trên
 * màn hình, KHÔNG chặn nhắn — chặn theo quyền sẽ khoá oan người phụ trách
 * dù họ đang cầm số thật (toast "không có quyền" sai).
 */
export function ZaloPhoneLink({ phone, masked = false, viewerCanSeeFull, className }: ZaloPhoneLinkProps) {
  const { can } = usePermissions()
  const trimmed = phone?.trim()
  const shouldMask = viewerCanSeeFull !== undefined ? !viewerCanSeeFull : masked && !can("contacts.phone_full")
  const displayPhone = shouldMask ? maskPhone(phone) : phone

  if (!trimmed) return <span className={className}>{displayPhone}</span>

  return (
    <button
      type="button"
      onClick={(e) => {
        // preventDefault + stopPropagation: khi nằm TRONG <Link> (vd card Kanban),
        // chặn CẢ điều hướng <a> mặc định (hard reload) LẪN
        // soft-nav của Next — chỉ mở tab Zalo mới.
        e.preventDefault()
        e.stopPropagation()
        // QUYỀN NHẮN chỉ dựa isMaskedPhone (BE là nguồn chân lý) — KHÔNG dùng
        // shouldMask (role) ở đây, tránh khoá oan người phụ trách đang cầm số thật.
        if (isMaskedPhone(trimmed)) {
          toast.error("Bạn không có quyền xem số này để nhắn tin")
          return
        }
        window.open(buildZaloDirectUrl(trimmed), "_blank", "noopener")
      }}
      title="Nhắn tin Zalo với khách hàng"
      className={cn(
        "inline-flex items-center gap-1.5 text-inherit no-underline transition-colors bg-transparent border-0 p-0",
        "hover:text-[#0068FF] cursor-pointer",
        className,
      )}
    >
      <span>{displayPhone}</span>
      <MessageCircle className="h-4 w-4 text-[#0068FF]" />
    </button>
  )
}
