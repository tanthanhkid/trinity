import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { renderHook } from '@testing-library/react'

/**
 * Hồi quy — vế "không phát âm thanh thông báo".
 *
 * `primeAudioOnce()` (hooks/use-notification-sound.ts) gỡ 3 listener gesture
 * ngay khi user click lần đầu. Bản cũ gỡ ĐỒNG BỘ, TRƯỚC khi biết
 * `AudioContext.resume()` thành công hay không. Resume hỏng (tab nền, iOS ngắt
 * phiên audio, gesture bị coi là không hợp lệ) ⇒ context KHÔNG được prime,
 * listener thì đã mất, mà `primeAudioOnce()` chỉ chạy 1 lần trong
 * `useEffect(..., [])` lúc mount ⇒ không còn đường prime lại. Mọi âm báo sau đó
 * đều phát từ handler socket (không phải user gesture) nên bị trình duyệt chặn,
 * và lỗi bị `.catch(() => {})` nuốt ⇒ im lặng tuyệt đối tới hết phiên.
 *
 * Test dựng AudioContext giả có `resume()` hỏng lần đầu, thành công lần sau.
 */

type ResumeFn = () => Promise<void>

let resumeMock: Mock<() => Promise<void>>
let ctxState: AudioContextState

function installFakeAudioContext(): void {
  class FakeAudioContext {
    get state(): AudioContextState {
      return ctxState
    }
    resume: ResumeFn = () => resumeMock()
    close(): Promise<void> {
      return Promise.resolve()
    }
    createOscillator() {
      return {
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        frequency: { setValueAtTime: vi.fn() },
        type: 'sine',
      }
    }
    createGain() {
      return {
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      }
    }
    get currentTime(): number {
      return 0
    }
    get destination() {
      return {}
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

/** Chỉ cần đọc `mock.calls` — khai lỏng để không phải khớp generic của `vi.spyOn`. */
type CallSpy = { mock: { calls: unknown[][] } }

/**
 * Nhả hàng đợi microtask để `.catch()` + `.finally()` của `ctx.resume()` chạy xong.
 * `resume()` đang chạy thì gesture kế tiếp bị BỎ QUA có chủ đích (chống gọi
 * chồng khi user gõ phím liên tục) — nên test phải ĐỢI nó lắng, không được đua.
 */
const settle = () => new Promise((r) => setTimeout(r, 0))

/** Số listener gesture đang gắn trên `document` (capture phase). */
function countGestureListeners(addSpy: CallSpy, removeSpy: CallSpy): number {
  const GESTURES = new Set(['click', 'keydown', 'pointerdown'])
  const added = addSpy.mock.calls.filter((c) => GESTURES.has(c[0] as string)).length
  const removed = removeSpy.mock.calls.filter((c) => GESTURES.has(c[0] as string)).length
  return added - removed
}

describe('primeAudioOnce — giữ listener khi resume() thất bại', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    ctxState = 'suspended'
    installFakeAudioContext()
  })

  it('resume() reject ở gesture đầu → listener VẪN còn để gesture sau prime lại', async () => {
    resumeMock = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('not allowed'))

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { useNotificationSound } = await import('@/hooks/use-notification-sound')
    renderHook(() => useNotificationSound())

    expect(countGestureListeners(addSpy, removeSpy)).toBe(3)

    // Gesture 1 — resume() hỏng.
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(1))
    await settle() // để catch + finally chạy xong (nhả cờ chống gọi chồng)

    // 🔴 Điểm chốt: bản cũ trả về 0 ở đây (listener đã bị gỡ đồng bộ) ⇒ câm vĩnh viễn.
    expect(countGestureListeners(addSpy, removeSpy)).toBe(3)

    // Gesture 2 — resume() thành công, giờ mới được gỡ listener.
    resumeMock.mockResolvedValueOnce(undefined)
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(countGestureListeners(addSpy, removeSpy)).toBe(0))
  })

  it('resume() thành công ngay gesture đầu → gỡ đủ 3 listener (không leak)', async () => {
    resumeMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { useNotificationSound } = await import('@/hooks/use-notification-sound')
    renderHook(() => useNotificationSound())

    expect(countGestureListeners(addSpy, removeSpy)).toBe(3)

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(countGestureListeners(addSpy, removeSpy)).toBe(0))
  })

  it('unmount TRONG LÚC resume() còn treo, rồi reject → lần mount sau VẪN đăng ký lại được', async () => {
    // Đua thật: user bấm chuột → resume() chưa xong → điều hướng rời (dashboard)
    // / đăng xuất (unmount, cleanup đã gỡ listener) → promise mới reject.
    // Nếu catch đặt `_primingListenersRegistered = true` vô điều kiện thì cờ
    // module kẹt `true` trong khi không listener nào còn gắn ⇒ lần mount sau bị
    // `if (_primingListenersRegistered) return` chặn ⇒ câm vĩnh viễn.
    let rejectResume: (err: Error) => void = () => {}
    resumeMock = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { rejectResume = rej }))

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { useNotificationSound } = await import('@/hooks/use-notification-sound')
    const first = renderHook(() => useNotificationSound())

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(1))

    // Rời trang khi resume còn treo → cleanup gỡ sạch listener.
    first.unmount()
    expect(countGestureListeners(addSpy, removeSpy)).toBe(0)

    // Giờ promise mới hỏng. PHẢI đợi `catch` + `finally` chạy XONG rồi mới
    // mount lại — không thì test đua qua mặt chính nhánh đang cần kiểm và sẽ
    // xanh cả với bản lỗi (đã dính đúng bẫy này một lần).
    rejectResume(new Error('interrupted'))
    await settle()
    expect(countGestureListeners(addSpy, removeSpy)).toBe(0)

    // 🔴 Điểm chốt: mount lại PHẢI đăng ký lại đủ 3 listener.
    resumeMock.mockResolvedValue(undefined)
    renderHook(() => useNotificationSound())
    expect(countGestureListeners(addSpy, removeSpy)).toBe(3)
  })

  it('unmount trước gesture → cleanup gỡ đủ listener (không leak)', async () => {
    resumeMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { useNotificationSound } = await import('@/hooks/use-notification-sound')
    const { unmount } = renderHook(() => useNotificationSound())

    expect(countGestureListeners(addSpy, removeSpy)).toBe(3)
    unmount()
    expect(countGestureListeners(addSpy, removeSpy)).toBe(0)
  })
})
