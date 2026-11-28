"use client"

/* =============================================================================
 * «Lưu SĐT vào hồ sơ» ngay dưới bong bóng khách (hopthu-desktop / hopthu-mobile «Ánh xanh»).
 * Số do MÁY CHỦ dò trong tin (`phones` của GET /zalo-oa/threads/:id/messages) — web không tự dò.
 * Bấm = POST /zalo-oa/threads/:id/save-phone: tạo khách (hoặc ghép khách đã có số này) rồi ghép vào hội thoại.
 * ========================================================================== */

import { Plus } from "lucide-react"
import { formatPhone } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Cùng một số? So theo 9 chữ số cuối: `0912…`, `84912…`, `+84 912…` đều là một. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const tail = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-9)
  const x = tail(a)
  return x.length === 9 && x === tail(b)
}

/**
 * Trạng thái của một số trong tin:
 *  - `saved`: hồ sơ (hoặc hội thoại) đã mang đúng số này → «Đã lưu số này vào hồ sơ»;
 *  - `offer`: hội thoại chưa ghép khách và người dùng được sửa khách → nút «Lưu … vào hồ sơ»;
 *  - `none`: còn lại (khách đã có SỐ KHÁC, hoặc thiếu quyền) → không hiện gì, tránh nút luôn bị từ chối.
 */
export function savePhoneState(opts: {
  phone: string
  linked: boolean
  profilePhone: string | null | undefined
  canUpdate: boolean
}): "saved" | "offer" | "none" {
  if (opts.linked && samePhone(opts.profilePhone, opts.phone)) return "saved"
  if (!opts.linked && opts.canUpdate) return "offer"
  return "none"
}

export function SavePhoneAction({
  phone,
  state,
  pending,
  disabled,
  onSave,
}: {
  /** Dạng nội địa `0xxxxxxxxx` do máy chủ trả. */
  phone: string
  state: "saved" | "offer"
  pending?: boolean
  disabled?: boolean
  onSave: () => void
}) {
  if (state === "saved") {
    return <p className="px-1 text-[13px] font-semibold text-ax-success">Đã lưu số này vào hồ sơ</p>
  }
  return (
    <button
      type="button"
      disabled={pending || disabled}
      onClick={onSave}
      className={cn(
        "inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-ax-primary bg-ax-surface px-3.5 text-sm font-semibold text-ax-primary-ink outline-none max-lg:h-11 max-lg:px-4 max-lg:text-[15px]",
        "transition-colors duration-150 hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {/* Thiết kế mobile không có dấu +. */}
      <Plus aria-hidden className="size-3.5 max-lg:hidden" strokeWidth={2.4} />
      <span className="ax-amount">{pending ? "Đang lưu…" : `Lưu ${formatPhone(phone)} vào hồ sơ`}</span>
    </button>
  )
}
