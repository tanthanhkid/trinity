'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { io, Socket } from 'socket.io-client'
import { useAuthStore } from '@/store/auth'
import { useNotificationSound } from '@/hooks/use-notification-sound'
import { resolveWsBaseUrl } from '@/lib/ws-url'
import apiClient from '@/lib/api-client'
import { isPollMode, NOTIFICATION_POLL_INTERVAL_MS } from '@/lib/realtime-mode'
import { pickNewNotifications, type PolledNotification } from '@/lib/notification-poll'

interface NotificationPayload {
  id?: number
  title: string
  body: string
  channel: string
  event_type?: string
  action_url?: string | null
  is_read: boolean
  created_at: string
}

/**
 * Âm báo — theo SỰ KIỆN, không theo vai trò (RBAC quyền + phạm vi).
 *
 * BE chỉ đẩy notification đích danh tới người được phép nhận (room
 * `user_${recipientId}`; vd thông báo giao việc chỉ tới người được giao)
 * nên FE không cần lọc thêm theo vai trò. Chỉ còn các sự kiện có yêu cầu bật
 * tiếng chuông: `deal.assigned` (thương vụ giao cho nhân viên). `play() (use-notification-sound) vẫn tôn trọng cờ
 * tắt/bật âm per-máy (`trinity:notif:sound-enabled`) + throttle 500ms.
 */
const SOUND_EVENTS = new Set(['deal.assigned'])

/**
 * Origin để mở socket. Luật thuần + lý do đầy đủ nằm ở `lib/ws-url.ts` — TÓM
 * TẮT: `new URL()` KHÔNG throw với chuỗi dạng `"localhost:8080"` mà trả origin
 * opaque (chuỗi `"null"`), nên bản cũ nối tới `https://null/...` và treo tới
 * timeout. Giá trị hợp lệ (relative "/api/v1", absolute
 * https://…, hoặc không set) cho kết quả Y HỆT bản cũ.
 */
function getWsBaseUrl(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return resolveWsBaseUrl(process.env.NEXT_PUBLIC_API_URL, origin, (reason) => {
    // Cấu hình env sai là nguyên nhân im lặng nhất của "chuông không realtime"
    // — nói ra ở console thay vì âm thầm fallback.
    console.warn(`[NotificationSocket] ${reason} — dùng origin của trang thay thế`)
  })
}

export function NotificationSocket() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const accessToken = useAuthStore((s) => s.accessToken)
  const socketRef = useRef<Socket | null>(null)
  // routerRef: tránh stale closure khi router thay đổi (Next.js App Router)
  const routerRef = useRef(router)
  routerRef.current = router
  // Âm báo thông báo. Dùng ref tránh stale closure trong useEffect
  // Không đưa `play` vào deps để khỏi reconnect socket.
  const { play } = useNotificationSound()
  const playRef = useRef(play)
  playRef.current = play

  // Xử lý 1 thông báo mới (toast + âm + invalidate) — DÙNG CHUNG cho socket và poll nên hai chế độ
  // hành xử y hệt nhau. Ref: không đưa vào deps của effect để khỏi reconnect/poll lại.
  const handleNewRef = useRef<(payload: NotificationPayload) => void>(() => undefined)
  handleNewRef.current = (payload: NotificationPayload) => {
    // toast hiện cho MỌI user đăng nhập — mỗi socket chỉ nhận
    // payload BE đã gán riêng cho user đó nên không leak. Việc invalidate
    // React Query bên dưới giữ realtime Kanban/dashboard.
    // deal.assigned — thương vụ mới giao cho nhân viên
    const isDealAssigned = payload.event_type === 'deal.assigned'
    // Âm báo theo sự kiện (xem `SOUND_EVENTS`). `play()` tự tôn trọng cờ tắt
    // âm per-máy + throttle.
    if (typeof payload.event_type === 'string' && SOUND_EVENTS.has(payload.event_type)) {
      playRef.current()
    }
    // Validate action_url: chỉ chấp nhận internal path (bắt đầu '/', không phải '//').
    const rawUrl =
      typeof payload.action_url === 'string' &&
      payload.action_url.startsWith('/') &&
      !payload.action_url.startsWith('//') &&
      !payload.action_url.startsWith('/\\')
        ? payload.action_url
        : null
    const safeUrl = rawUrl
    const actionLabel = isDealAssigned ? 'Mở thương vụ' : 'Xem'
    const duration = isDealAssigned ? 8000 : 5000
    toast.info(payload.title, {
      description: payload.body,
      duration,
      ...(safeUrl ? { action: { label: actionLabel, onClick: () => routerRef.current.push(safeUrl) } } : {}),
    })
    void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
    void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] })
    // Khi nhận deal mới → invalidate dashboard-stats-today để counter
    // tăng ngay lập tức thay vì đợi chu kỳ refetch.
    if (isDealAssigned) {
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats-today'] })
    }
  }

  // Chế độ poll (serverless): hỏi danh sách chưa đọc mỗi 60s + khi tab được focus; KHÔNG mở socket. Lượt hỏi này cũng
  // làm mới hai con số trên chuông (chuông không tự hỏi riêng ở chế độ poll).
  useEffect(() => {
    if (!accessToken || !isPollMode()) return
    const seen = new Set<string>()
    let primed = false
    let lastSig: string | null = null
    let inFlight = false
    let stopped = false
    const poll = async () => {
      if (inFlight || stopped || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const res = await apiClient.get<{ data: PolledNotification[] }>('/notifications', {
          params: { read: false, limit: 20 },
        })
        const fresh = pickNewNotifications(res.data.data ?? [], seen, primed)
        // Danh sách chưa đọc đổi (có tin mới, hoặc đã đọc ở thiết bị khác) ⇒ làm mới hai số trên chuông; không đổi thì
        // không gọi thêm (mỗi chu kỳ đúng 1 lượt gọi).
        const sig = (res.data.data ?? []).map((n) => String(n.id)).sort().join(',')
        if (primed && sig !== lastSig) void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
        lastSig = sig
        primed = true
        for (const n of fresh) {
          handleNewRef.current({
            id: typeof n.id === 'number' ? n.id : Number(n.id),
            title: n.title,
            body: n.body,
            channel: n.channel ?? 'in_app',
            event_type: n.event_type ?? undefined,
            action_url: n.action_url ?? null,
            is_read: n.is_read,
            created_at: n.created_at,
          })
        }
      } catch {
        // Lỗi mạng tạm: giữ trạng thái, lượt sau thử lại (không reset gì cả).
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), NOTIFICATION_POLL_INTERVAL_MS)
    const onWake = () => void poll()
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [accessToken, queryClient])

  useEffect(() => {
    if (!accessToken || isPollMode()) return

    const socket = io(`${getWsBaseUrl()}/notifications/ws`, {
      path: '/notif-ws',
      // Callback form: always reads latest token from store on each (re)connect,
      // so token refresh doesn't leave socket with a stale JWT.
      auth: (cb: (data: Record<string, string>) => void) =>
        cb({ token: useAuthStore.getState().accessToken ?? '' }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 30000,
    })
    socketRef.current = socket

    socket.on('notification:new', (payload: NotificationPayload) => handleNewRef.current(payload))

    // BE gửi 3 con số (tổng/thông báo/tin nhắn) theo category.
    // Thay vì tự gán số thô vào cache (dễ lệch shape + double-decrement khi
    // socket VÀ response mark-as-read cùng bắn), CHỈ invalidate để React
    // Query tự refetch từ nguồn COUNT thật — luôn khớp badge lẫn popup.
    socket.on('notification:count', () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] })
    })

    socket.on('connect_error', (err: Error) => {
      const msg = err.message.toLowerCase()
      if (msg.includes('jwt') || msg.includes('token') || msg.includes('unauthorized')) {
        toast.warning('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
      } else {
        console.warn('[NotificationSocket] Connection error:', err.message)
      }
    })

    socket.on('reconnect_failed', () => {
      toast.warning('Mất kết nối thời gian thực — vui lòng tải lại trang')
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [accessToken, queryClient])

  return null
}
