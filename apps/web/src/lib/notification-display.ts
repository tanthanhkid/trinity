import {
  Bell,
  Wallet,
  MessageSquare,
  Info,
  Newspaper,
  CalendarClock,
  Inbox,
  Bot,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Category routing — dùng chung giữa notifications-bell + notification-panel.
// ---------------------------------------------------------------------------

/**
 * Các event_type thuộc nhóm "Tin nhắn & đề cập" (icon MessageSquare).
 * Tất cả event còn lại → nhóm "Thông báo" (icon Bell).
 */
export const MESSAGE_EVENT_TYPES = new Set([
  'chat.tag',
])

export function isMessageEvent(eventType: string | null): boolean {
  return !!eventType && MESSAGE_EVENT_TYPES.has(eventType)
}

export function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diffMs = now - date
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return 'Vừa xong'
  if (diffMin < 60) return `${diffMin} phút trước`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} giờ trước`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return `${diffDay} ngày trước`

  return new Date(dateStr).toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export type EventStyle = { icon: typeof Bell; iconClass: string; dotClass: string }

export const EVENT_CONFIG: Record<string, EventStyle> = {
  'deal.assigned': { icon: Inbox, iconClass: 'text-emerald-600 bg-emerald-50', dotClass: 'bg-emerald-500' },
  'ai_action.created': { icon: Bot, iconClass: 'text-indigo-600 bg-indigo-50', dotClass: 'bg-indigo-500' },
  'extension.pending': { icon: Bot, iconClass: 'text-indigo-600 bg-indigo-50', dotClass: 'bg-indigo-500' },
  'extension.auto_disabled': { icon: Info, iconClass: 'text-red-600 bg-red-50', dotClass: 'bg-red-500' },
  'chat.tag': { icon: MessageSquare, iconClass: 'text-violet-600 bg-violet-50', dotClass: 'bg-violet-500' },
  'payslip.approved': { icon: Wallet, iconClass: 'text-green-600 bg-green-50', dotClass: 'bg-green-500' },
  'newsfeed.post.created': { icon: Newspaper, iconClass: 'text-sky-600 bg-sky-50', dotClass: 'bg-sky-500' },
  'attendance.request.created': { icon: CalendarClock, iconClass: 'text-indigo-600 bg-indigo-50', dotClass: 'bg-indigo-500' },
}

export const DEFAULT_EVENT_CONFIG: EventStyle = {
  icon: Info,
  iconClass: 'text-gray-600 bg-gray-50',
  dotClass: 'bg-gray-500',
}
