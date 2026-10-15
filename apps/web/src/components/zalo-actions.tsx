"use client"

import { MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { buildZaloDirectUrl, isMaskedPhone } from "@/lib/zalo"
import { cn } from "@/lib/utils"

// Nút "Nhắn tin Zalo" — mở deeplink Zalo native `https://zalo.me/{phone}` trên tab mới. Mobile mở Zalo app.
//
// ⚠️ QUYỀN NHẮN dựa DUY NHẤT vào `isMaskedPhone(phone)` — BE `PhoneMaskInterceptor`
// là nguồn chân lý (trả số THẬT iff viewer được phép, gồm owner-override cho người phụ trách;
// che `0900***001` nếu không). KHÔNG tự suy quyền từ role: chặn theo role khoá oan
// người phụ trách đang cầm số thật. 2 nút này không hiển thị SĐT nên không
// cần che hiển thị theo role — khác `ZaloPhoneLink` (có `displayPhone`).

/** Mở deeplink Zalo cho SĐT nếu KHÔNG bị che; ngược lại toast lỗi. */
function openZaloOrWarn(trimmed: string) {
  if (isMaskedPhone(trimmed)) {
    toast.error("Bạn không có quyền xem số này để nhắn tin")
    return
  }
  window.open(buildZaloDirectUrl(trimmed), "_blank", "noopener")
}

interface ZaloActionsProps {
  phone: string
  className?: string
}

/** Nút "Nhắn tin Zalo" — kích thước outline button (dùng cho contact/lead detail). */
export function ZaloActions({ phone, className }: ZaloActionsProps) {
  const trimmed = phone?.trim()
  if (!trimmed) return null

  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openZaloOrWarn(trimmed)
        }}
        className="h-9 text-sm"
      >
        <MessageCircle className="mr-1.5 h-4 w-4" />
        Nhắn tin Zalo
      </Button>
    </div>
  )
}

interface ZaloIconLinkProps {
  phone: string
  className?: string
}

/** Icon-only nút Zalo (dùng cho Kanban cards, inline list). */
export function ZaloIconLink({ phone, className }: ZaloIconLinkProps) {
  const trimmed = phone?.trim()
  if (!trimmed) return null

  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          className={cn(
            "inline-flex items-center justify-center h-6 w-6 rounded hover:bg-[#0068FF]/10 transition-colors",
            className,
          )}
          render={
            <button
              type="button"
              onClick={(e) => {
                // preventDefault: ZaloIconLink render TRONG <Link> card Kanban
                // (danh sách khách) → chặn hard-nav thẻ <a>, chỉ mở tab Zalo.
                e.preventDefault()
                e.stopPropagation()
                openZaloOrWarn(trimmed)
              }}
              aria-label="Nhắn tin Zalo"
            />
          }
        >
          <MessageCircle className="h-3.5 w-3.5 text-[#0068FF]" />
        </TooltipTrigger>
        <TooltipContent side="top">Nhắn tin Zalo</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
