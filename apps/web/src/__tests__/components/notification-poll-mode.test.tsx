import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const { getMock, ioMock, toastInfo, playMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  ioMock: vi.fn(),
  toastInfo: vi.fn(),
  playMock: vi.fn(),
}))

vi.mock('@/lib/api-client', () => ({ default: { get: getMock } }))
vi.mock('socket.io-client', () => ({ io: ioMock }))
vi.mock('sonner', () => ({ toast: { info: toastInfo, warning: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/hooks/use-notification-sound', () => ({ useNotificationSound: () => ({ play: playMock }) }))
vi.mock('@/store/auth', () => {
  const state = { accessToken: 'tok' }
  const useAuthStore = (sel: (s: typeof state) => unknown) => sel(state)
  useAuthStore.getState = () => state
  return { useAuthStore }
})

import { NotificationSocket } from '@/components/notification-socket'
import { pickNewNotifications, MAX_TOASTS_PER_POLL, type PolledNotification } from '@/lib/notification-poll'

const n = (id: number, extra: Partial<PolledNotification> = {}): PolledNotification => ({
  id,
  title: `T${id}`,
  body: 'B',
  channel: 'in_app',
  event_type: null,
  action_url: null,
  is_read: false,
  created_at: '2026-10-06T00:00:00Z',
  ...extra,
})

describe('pickNewNotifications', () => {
  it('lần đầu chỉ ghi nhớ, không toast', () => {
    const seen = new Set<string>()
    expect(pickNewNotifications([n(3), n(2)], seen, false)).toEqual([])
    expect([...seen].sort()).toEqual(['2', '3'])
  })

  it('lần sau chỉ trả id chưa thấy, theo thứ tự cũ → mới, không trùng', () => {
    const seen = new Set<string>(['1'])
    const out = pickNewNotifications([n(3), n(2), n(1)], seen, true)
    expect(out.map((x) => x.id)).toEqual([2, 3])
    expect(pickNewNotifications([n(3), n(2), n(1)], seen, true)).toEqual([])
  })

  it('bỏ kênh không phải in_app, giữ khi BE không trả channel', () => {
    const seen = new Set<string>()
    const out = pickNewNotifications([n(2, { channel: 'email' }), n(1, { channel: undefined })], seen, true)
    expect(out.map((x) => x.id)).toEqual([1])
  })

  it('giới hạn số toast mỗi lượt', () => {
    const items = Array.from({ length: 12 }, (_, i) => n(100 - i))
    const out = pickNewNotifications(items, new Set(), true)
    expect(out).toHaveLength(MAX_TOASTS_PER_POLL)
    expect(out[out.length - 1].id).toBe(100)
  })
})

describe('NotificationSocket — NEXT_PUBLIC_REALTIME_MODE', () => {
  const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    vi.useFakeTimers()
    getMock.mockReset()
    ioMock.mockReset().mockReturnValue({ on: vi.fn(), disconnect: vi.fn() })
    toastInfo.mockReset()
    playMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('không đặt cờ → mở socket như cũ, không poll', async () => {
    const qc = new QueryClient()
    render(<NotificationSocket />, { wrapper: wrap(qc) })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    // socket.io-client nạp động (import()) ⇒ io được gọi sau một nhịp, không đồng bộ lúc render.
    expect(ioMock).toHaveBeenCalledTimes(1)
    expect(getMock).not.toHaveBeenCalled()
  })

  it('poll: KHÔNG mở socket; lần đầu không toast; thông báo mới → toast đúng 1 lần + âm + invalidate', async () => {
    vi.stubEnv('NEXT_PUBLIC_REALTIME_MODE', 'poll')
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    getMock.mockResolvedValueOnce({ data: { data: [n(1)] } })
    render(<NotificationSocket />, { wrapper: wrap(qc) })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(ioMock).not.toHaveBeenCalled()
    expect(getMock).toHaveBeenCalledWith('/notifications', { params: { read: false, limit: 20 } })
    expect(toastInfo).not.toHaveBeenCalled()
    // Chu kỳ 60 giây (gộp cả việc làm mới số chưa đọc): 30 giây chưa hỏi lại.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(getMock).toHaveBeenCalledTimes(1)

    getMock.mockResolvedValue({ data: { data: [n(2, { event_type: 'deal.assigned', title: 'Deal mới' }), n(1)] } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(toastInfo.mock.calls[0][0]).toBe('Deal mới')
    expect(playMock).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications', 'unread-count'] })

    // lượt poll kế tiếp trả cùng dữ liệu → không toast trùng, không làm mới số chưa đọc (đúng 1 lượt gọi mỗi chu kỳ)
    const countCalls = () => invalidate.mock.calls.filter((c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ['notifications', 'unread-count'] })).length
    const before = countCalls()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(countCalls()).toBe(before)
  })

  it('poll: lỗi mạng không làm hỏng, lượt sau vẫn chạy; focus tab kích poll ngay', async () => {
    vi.stubEnv('NEXT_PUBLIC_REALTIME_MODE', 'poll')
    const qc = new QueryClient()
    getMock.mockRejectedValueOnce(new Error('net')).mockResolvedValue({ data: { data: [] } })
    render(<NotificationSocket />, { wrapper: wrap(qc) })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getMock).toHaveBeenCalledTimes(2)
  })
})
