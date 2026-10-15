export interface NotificationLink {
  event_type: string | null
  action_url: string | null
}

function isSafeInternalPath(url: string | null | undefined): url is string {
  if (!url) return false
  if (!url.startsWith('/')) return false
  if (url.startsWith('//') || url.startsWith('/\\')) return false
  return true
}

export function resolveNotificationHref(
  /** Có quyền quản lý lương (`payroll.manage`) — dẫn thẳng tab Phiếu lương. */
  canManagePayroll: boolean,
  notification: NotificationLink,
): string | null {
  // Guard: không có route /deals/<id> trong app → bỏ action_url dạng /deals/*
  // để rơi vào fallback theo event_type bên dưới.
  const actionUrl =
    notification.action_url?.startsWith('/deals/')
      ? null
      : notification.action_url

  if (isSafeInternalPath(actionUrl)) return actionUrl
  if (actionUrl) {
    console.warn('[notifications-bell] rejected unsafe action_url', actionUrl)
  }

  const eventType = notification.event_type
  if (!eventType) return null

  // deal.assigned: thương vụ giao cho nhân viên → dẫn đến danh bạ contacts.
  // action_url do backend gửi (= /contacts/<id>); fallback ở đây cho notification
  // không có action_url hợp lệ.
  if (eventType === 'deal.assigned') {
    return '/contacts'
  }
  // Hoạt động AI / đề xuất thao tác của AI chờ duyệt (chế độ duyệt) — fallback khi action_url (/ai-actions?id=N) không hợp lệ.
  if (eventType === 'ai_action.created') return '/ai-actions'
  // Chương trình con do AI viết chờ duyệt / bị tự tắt — fallback khi action_url (/extensions?id=N) không hợp lệ.
  if (eventType === 'extension.pending' || eventType === 'extension.auto_disabled') return '/extensions'
  if (eventType === 'payslip.approved') {
    return canManagePayroll ? '/payroll?tab=payslip' : '/payroll'
  }
  // Bài đăng mới trên bảng tin — fallback khi action_url (/newsfeed?post=<id>)
  // không hợp lệ hoặc notification cũ chưa có action_url.
  if (eventType === 'newsfeed.post.created') return '/newsfeed'
  // Đơn chấm công mới — người quản lý chấm công vào trang Quản lý chấm công (tab Quản lý đơn).
  if (eventType === 'attendance.request.created') return '/management/workdays'

  console.warn('[notifications-bell] no href for event_type', eventType)
  return null
}
