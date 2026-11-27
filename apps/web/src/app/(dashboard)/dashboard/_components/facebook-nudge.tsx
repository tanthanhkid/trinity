'use client'

import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { AlertTriangle } from 'lucide-react'
import { SMALL_BTN } from './home-box'

/** Màn Kết nối, mục Facebook — cùng đích với `href` mà `/reports/dashboard-channels` trả cho Fanpage. */
export const FACEBOOK_CONNECT_HREF = '/connections?muc=facebook'

/**
 * Dải cảnh báo "chưa nối Fanpage": nói rõ hậu quả; chỉ người quản lý kết nối thấy nút, người khác thấy câu nhắc báo quản trị viên.
 * `unconnected` do trang quyết (từ `/reports/dashboard-channels`); nối xong dữ liệu đổi ⇒ dải tự ẩn.
 */
export function FacebookNudge({ unconnected, canManage, href = FACEBOOK_CONNECT_HREF }: { unconnected: boolean; canManage: boolean; href?: string }) {
  if (!unconnected) return null
  return (
    <div
      role="alert"
      data-testid="facebook-nudge"
      className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--color-app-tag-amber-ink)]/30 bg-[var(--color-app-tag-amber-bg)] px-4 py-3 text-[var(--color-app-tag-amber-ink)] sm:flex-row sm:items-center"
    >
      <AlertTriangle className="size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">Chưa kết nối Fanpage Facebook</p>
        <p className="text-[14px] leading-snug">
          Tin nhắn và bình luận từ Fanpage chưa về Trinity, khách nhắn vào sẽ không hiện ở đây.
          {!canManage && ' Hãy báo quản trị viên kết nối Fanpage.'}
        </p>
      </div>
      {canManage && (
        <Link href={href} data-testid="facebook-nudge-cta" className={SMALL_BTN}>
          Kết nối Fanpage
        </Link>
      )}
    </div>
  )
}
