'use client'
import { readUiPref, writeUiPref } from '@/lib/ui-pref-storage'

import { useRef, useCallback, useEffect } from 'react'
import {
  getNotificationSoundId,
  scheduleNotificationSound,
} from '@/lib/notification-sounds'

const SOUND_ENABLED_KEY = 'trinity:notif:sound-enabled'

// Module-level AudioContext singleton — tái sử dụng qua các lần hook remount.
// Khởi tạo lazy để tránh tạo AudioContext khi SSR (không có window).
let _audioCtx: AudioContext | null = null
// Cờ "đã prime (resume) AudioContext HIỆN TẠI qua user gesture". Module-level để
// tồn tại qua remount. Reset = false MỖI khi tạo AudioContext mới (cái cũ bị
// browser đóng) → context mới luôn được prime lại ở gesture kế tiếp. KHÔNG dùng
// sessionStorage: cờ session sống dai hơn context, làm context mới không được prime.
let _contextPrimed = false

function getAudioContext(): AudioContext | null {
  if (
    typeof AudioContext === 'undefined' &&
    typeof (window as unknown as { webkitAudioContext?: unknown })
      .webkitAudioContext === 'undefined'
  )
    return null
  try {
    if (!_audioCtx || _audioCtx.state === 'closed') {
      const Ctor =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (
              window as unknown as {
                webkitAudioContext: typeof AudioContext
              }
            ).webkitAudioContext
      _audioCtx = new Ctor()
      _contextPrimed = false // context mới → cần prime lại ở gesture kế tiếp
    }
    return _audioCtx
  } catch {
    return null
  }
}

/**
 * Phát âm báo thông báo dùng Web Audio API (OscillatorNode), tổng hợp tại runtime.
 *
 * Âm báo cụ thể (chuỗi tone) định nghĩa trong `lib/notification-sounds.ts` —
 * người dùng chọn trong Settings → Thông báo. Truyền `id` để phát một âm cụ thể
 * (dùng cho nút "Nghe thử"); bỏ trống → đọc âm đang chọn từ localStorage.
 *
 * Ưu điểm so với HTMLAudioElement + data URI:
 * - Không phụ thuộc binary WAV encoding (WAV cũ bị malformed → 1.5ms, không nghe được).
 * - Tổng hợp tại runtime → không rủi ro lỗi giải mã.
 * - Hỗ trợ Safari iOS (webkit prefix) và Android Chrome.
 * - Envelope fade-in/fade-out tránh click artifact.
 */
function playSound(id?: string): void {
  const ctx = getAudioContext()
  if (!ctx) return

  const soundId = id ?? getNotificationSoundId()
  const run = () => {
    try {
      scheduleNotificationSound(ctx, soundId)
    } catch {
      // Bỏ qua lỗi schedule (vd: AudioContext bị browser đóng giữa chừng).
    }
  }

  // Resume khi context KHÔNG ở trạng thái 'running' — bao gồm 'suspended'
  // (Chrome/Firefox chưa có gesture) VÀ 'interrupted' (iOS Safari bị ngắt phiên
  // audio). Nếu chỉ check 'suspended', iOS rơi vào else → run() trên context
  // không chạy → mọi osc.start() bị bỏ qua (im lặng).
  if (ctx.state !== 'running') {
    ctx.resume().then(run).catch(() => {})
  } else {
    run()
  }
}

// Throttle: chặn spam beep khi burst nhiều event cùng lúc (vd fanout notify_on_enter_roles).
// Module-level để đồng bộ qua nhiều hook instance cùng mount.
let _lastPlayedAt = 0
const PLAY_THROTTLE_MS = 500

/**
 * Audio Priming — giải quyết browser autoplay policy.
 *
 * Chrome/Firefox/Safari chặn AudioContext.resume() nếu chưa có user gesture.
 * Pattern chuẩn: lần đầu user click/keydown/pointerdown bất kỳ → gọi ctx.resume()
 * để "unlock" AudioContext. Sau đó mọi playSound() đều hoạt động ngay lập tức.
 *
 * Module-level `_primingListenersRegistered` tránh double-registration khi
 * nhiều caller cùng mount. 3 caller THẬT (đã grep): `NotificationSocket` (mount
 * ở `(dashboard)/layout.tsx`) + trang Cài đặt > Thông báo
 * (`settings-notification-sound.tsx`). `NotificationsBell` KHÔNG gọi hook này —
 * nó chỉ hiển thị badge/dropdown, không phát âm.
 */
let _primingListenersRegistered = false

function primeAudioOnce(): () => void {
  if (typeof window === 'undefined') return () => {}

  // Đã prime context HIỆN TẠI rồi → không cần đăng ký lại. `_contextPrimed` reset
  // về false trong getAudioContext() khi context mới được tạo (xem getAudioContext).
  if (_contextPrimed) return () => {}

  if (_primingListenersRegistered) return () => {}
  _primingListenersRegistered = true

  // `attached` = SỰ THẬT DUY NHẤT về "3 listener còn gắn hay không" cho LẦN
  // đăng ký này. Cờ module `_primingListenersRegistered` có tới 3 nơi ghi
  // (đăng ký / finish / cleanup unmount) nên KHÔNG tự nó phản ánh được điều
  // đó — xem nhánh catch bên dưới.
  let attached = true

  const detach = () => {
    attached = false
    document.removeEventListener('click', handler, true)
    document.removeEventListener('keydown', handler, true)
    document.removeEventListener('pointerdown', handler, true)
  }

  // Chặn gọi chồng `ctx.resume()`: listener nay SỐNG cho tới khi prime xong,
  // nên user gõ phím liên tục sẽ bắn resume mỗi ký tự nếu không có cờ này.
  let resumePending = false

  const handler = () => {
    const ctx = getAudioContext()
    if (!ctx) return

    const finish = () => {
      _contextPrimed = true
      _primingListenersRegistered = false
      // 🔴 Gỡ listener CHỈ khi đã prime XONG. Xem docblock dưới đây.
      detach()
    }

    // Resume khi context KHÔNG 'running' (suspended hoặc iOS 'interrupted').
    if (ctx.state !== 'running') {
      if (resumePending) return
      resumePending = true
      ctx
        .resume()
        .then(finish)
        .catch(() => {
          // 🔴 — resume() THẤT BẠI thì phải GIỮ NGUYÊN listener để
          // gesture KẾ TIẾP thử lại. Bản cũ gỡ listener NGAY (đồng bộ, ngoài
          // promise) rồi mới biết resume hỏng: `_contextPrimed` vẫn false,
          // listener thì đã mất, mà `primeAudioOnce()` chỉ được gọi 1 lần trong
          // `useEffect(..., [])` lúc mount ⇒ KHÔNG còn đường đăng ký lại.
          // Từ đó mọi `playSound()` đều chạy từ handler socket (KHÔNG phải user
          // gesture) nên `ctx.resume()` bị trình duyệt từ chối, và lỗi bị
          // `.catch(() => {})` nuốt ⇒ IM LẶNG TUYỆT ĐỐI tới hết phiên.
          //
          // ⚠️ CHỈ bật lại cờ khi listener THẬT SỰ còn gắn. Nếu cleanup lúc
          // unmount đã chạy TRƯỚC khi promise reject (điều hướng rời
          // `(dashboard)` / đăng xuất giữa lúc resume còn treo) thì listener đã
          // bị gỡ; ghi `true` vô điều kiện ở đây sẽ khiến lần mount SAU rơi vào
          // `if (_primingListenersRegistered) return` và KHÔNG BAO GIỜ đăng ký
          // lại — tái lập đúng cái câm vĩnh viễn mà bản vá này đang sửa.
          if (attached) _primingListenersRegistered = true
        })
        .finally(() => {
          resumePending = false
        })
    } else {
      finish()
    }
  }

  document.addEventListener('click', handler, true)
  document.addEventListener('keydown', handler, true)
  // pointerdown: bắt cả touch/stylus gesture trên tablet/mobile (Chrome Android, iOS Safari)
  document.addEventListener('pointerdown', handler, true)

  return () => {
    detach()
    _primingListenersRegistered = false
  }
}

/**
 * Hook phát âm thanh thông báo.
 *
 * - play(): phát âm báo đang chọn nếu sound enabled + throttle 500ms.
 * - previewSound(id): nghe thử 1 âm cụ thể, BỎ QUA throttle + cờ enabled
 *   (dùng cho picker trong Settings — luôn phát khi user bấm "Nghe thử").
 * - isSoundEnabled(): đọc từ localStorage (default true).
 * - toggleSound(): đảo trạng thái và lưu vào localStorage.
 *
 * Root cause fix:
 * - WAV data URI cũ bị malformed: RIFF size=84 → 92 bytes → 24 samples @16kHz = 1.5ms (không nghe thấy).
 * - Thay bằng Web Audio API OscillatorNode: synthesize in-browser, không rủi ro encoding.
 * - CORS gateway: `process.env.CORS_ORIGIN ?? false` thay vì hardcode domain.
 */
export function useNotificationSound(): {
  play: () => void
  previewSound: (id?: string) => void
  isSoundEnabled: () => boolean
  toggleSound: () => void
} {
  // Mount-side effect: đăng ký priming handler ngay khi component mount.
  // Cleanup tránh listener leak khi component unmount trước khi user gesture.
  useEffect(() => {
    const cleanup = primeAudioOnce()
    return cleanup
  }, [])

  const isSoundEnabled = useCallback((): boolean => {
    try {
      const stored = readUiPref(SOUND_ENABLED_KEY)
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  }, [])

  const toggleSound = useCallback((): void => {
    try {
      writeUiPref(SOUND_ENABLED_KEY, String(!isSoundEnabled()))
    } catch {
      // localStorage không khả dụng
    }
  }, [isSoundEnabled])

  // isSoundEnabledRef: đọc localStorage tại thời điểm play() gọi,
  // tránh stale closure nếu user toggle giữa session.
  const isSoundEnabledRef = useRef(isSoundEnabled)
  isSoundEnabledRef.current = isSoundEnabled

  const play = useCallback((): void => {
    if (!isSoundEnabledRef.current()) return

    const now = Date.now()
    if (now - _lastPlayedAt < PLAY_THROTTLE_MS) return
    _lastPlayedAt = now

    playSound()
  }, [])

  // previewSound: nghe thử 1 âm cụ thể. Cố ý BỎ QUA throttle + cờ enabled —
  // user bấm "Nghe thử" trong Settings luôn nghe được ngay, kể cả khi đã tắt âm.
  const previewSound = useCallback((id?: string): void => {
    playSound(id)
  }, [])

  return { play, previewSound, isSoundEnabled, toggleSound }
}
