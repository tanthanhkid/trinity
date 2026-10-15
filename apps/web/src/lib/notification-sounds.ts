'use client'
import { readUiPref, writeUiPref } from '@/lib/ui-pref-storage'

// ---------------------------------------------------------------------------
// Bộ âm báo thông báo (notification ringtones) — tổng hợp bằng Web Audio API.
//
// Vì sao tổng hợp tại runtime thay vì file .mp3/.wav?
// - Không cần host asset, không rủi ro WAV malformed.
// - Hoạt động đồng nhất Chrome/Firefox/Safari iOS (webkit) + Android Chrome.
// - Mỗi âm báo là một chuỗi "tone segment" (oscillator + envelope).
//
// Người dùng chọn âm báo trong Settings → Thông báo; lựa chọn lưu localStorage
// (per trình duyệt, giống cờ bật/tắt `trinity:notif:sound-enabled`).
// ---------------------------------------------------------------------------

export const SOUND_ID_KEY = 'trinity:notif:sound-id'
export const DEFAULT_SOUND_ID = 'beep'

/** Một đoạn âm trong âm báo: tần số + thời điểm + bao hình (envelope). */
interface ToneSegment {
  /** Tần số (Hz). */
  freq: number
  /** Thời điểm bắt đầu, tính bằng giây kể từ đầu âm báo. */
  start: number
  /** Thời lượng (giây). */
  duration: number
  /** Dạng sóng — mặc định 'sine' (mềm, ít chói). */
  type?: OscillatorType
  /** Đỉnh âm lượng 0..1 — mặc định 0.5. */
  peak?: number
  /** Tần số kết thúc (Hz) — nếu có sẽ vuốt (glissando) freq → endFreq. */
  endFreq?: number
  /** Bao hình ngân/decay: âm lượng giảm tuyến tính từ peak → 0 suốt độ dài. */
  decay?: boolean
}

export interface NotificationSound {
  id: string
  /** Nhãn tiếng Việt hiển thị trong picker. */
  label: string
  /** Mô tả ngắn để người dùng hình dung. */
  description: string
  segments: ToneSegment[]
}

/**
 * Danh sách âm báo. `beep` đặt đầu tiên và là mặc định — tái tạo CHÍNH XÁC
 * âm bíp 880Hz/0.3s cũ để người dùng hiện tại không bị đổi âm bất ngờ.
 */
export const NOTIFICATION_SOUNDS: NotificationSound[] = [
  {
    id: 'beep',
    label: 'Bíp đơn (mặc định)',
    description: 'Một tiếng bíp ngắn, gọn — âm báo đang dùng hiện tại.',
    segments: [{ freq: 880, start: 0, duration: 0.3, type: 'sine', peak: 0.5 }],
  },
  {
    id: 'ding-dong',
    label: 'Đính – đoong',
    description: 'Hai nốt cao rồi thấp như chuông cửa.',
    segments: [
      { freq: 988, start: 0, duration: 0.2, type: 'sine', peak: 0.5 },
      { freq: 660, start: 0.18, duration: 0.36, type: 'sine', peak: 0.5, decay: true },
    ],
  },
  {
    id: 'chime',
    label: 'Chuông leng keng',
    description: 'Ba nốt đi lên nhẹ nhàng, dễ chịu.',
    segments: [
      { freq: 659, start: 0, duration: 0.18, type: 'triangle', peak: 0.55 },
      { freq: 880, start: 0.15, duration: 0.18, type: 'triangle', peak: 0.55 },
      { freq: 1175, start: 0.3, duration: 0.34, type: 'triangle', peak: 0.55, decay: true },
    ],
  },
  {
    id: 'tri-tone',
    label: 'Ba nốt báo tin',
    description: 'Ba nốt nhanh quen thuộc kiểu báo tin nhắn.',
    segments: [
      { freq: 1568, start: 0, duration: 0.14, type: 'sine', peak: 0.5 },
      { freq: 1046, start: 0.14, duration: 0.14, type: 'sine', peak: 0.5 },
      { freq: 1318, start: 0.28, duration: 0.22, type: 'sine', peak: 0.5, decay: true },
    ],
  },
  {
    id: 'pop',
    label: 'Tích (nhẹ nhàng)',
    description: 'Một tiếng tách rất ngắn, kín đáo — hợp môi trường yên tĩnh.',
    segments: [{ freq: 1200, start: 0, duration: 0.18, type: 'sine', peak: 0.55, decay: true }],
  },
  {
    id: 'sweep',
    label: 'Vút lên',
    description: 'Âm vuốt lên nhanh, tươi tắn.',
    segments: [{ freq: 520, endFreq: 1100, start: 0, duration: 0.32, type: 'sine', peak: 0.5 }],
  },
  {
    id: 'bell',
    label: 'Chuông ngân',
    description: 'Tiếng chuông ngân vang, có dư âm.',
    segments: [
      { freq: 784, start: 0, duration: 0.62, type: 'sine', peak: 0.55, decay: true },
      { freq: 1568, start: 0, duration: 0.5, type: 'sine', peak: 0.2, decay: true },
    ],
  },
  // ── Nhóm nhẹ nhàng ─────────────────────────────────────────────
  {
    id: 'harp',
    label: 'Thánh thót (nhẹ)',
    description: 'Ba nốt đàn ngân nhẹ, êm tai — thư giãn.',
    segments: [
      { freq: 587, start: 0, duration: 0.42, type: 'sine', peak: 0.42, decay: true },
      { freq: 880, start: 0.12, duration: 0.42, type: 'sine', peak: 0.42, decay: true },
      { freq: 1175, start: 0.24, duration: 0.52, type: 'sine', peak: 0.42, decay: true },
    ],
  },
  {
    id: 'water-drop',
    label: 'Giọt nước',
    description: 'Một tiếng "tóc" mềm vuốt xuống — rất nhẹ.',
    segments: [
      { freq: 1175, endFreq: 740, start: 0, duration: 0.3, type: 'sine', peak: 0.45, decay: true },
    ],
  },
  {
    id: 'soft-bell',
    label: 'Chuông gió',
    description: 'Hai nốt cao trong trẻo, ngân dịu — thoáng nhẹ.',
    segments: [
      { freq: 1318, start: 0, duration: 0.6, type: 'sine', peak: 0.4, decay: true },
      { freq: 1760, start: 0.18, duration: 0.55, type: 'sine', peak: 0.3, decay: true },
    ],
  },
  // ── Nhóm năng lượng ────────────────────────────────────────────
  {
    id: 'upbeat',
    label: 'Tươi vui (năng lượng)',
    description: 'Ba nốt sáng đi lên nhanh, phấn chấn.',
    segments: [
      { freq: 784, start: 0, duration: 0.12, type: 'triangle', peak: 0.5 },
      { freq: 1046, start: 0.1, duration: 0.12, type: 'triangle', peak: 0.5 },
      { freq: 1568, start: 0.2, duration: 0.26, type: 'triangle', peak: 0.58, decay: true },
    ],
  },
  {
    id: 'power-up',
    label: 'Bật năng lượng',
    description: 'Âm vuốt lên nhanh + nốt nhấn kiểu game — mạnh mẽ.',
    segments: [
      { freq: 440, endFreq: 1320, start: 0, duration: 0.22, type: 'sine', peak: 0.5 },
      { freq: 1760, start: 0.22, duration: 0.2, type: 'square', peak: 0.28, decay: true },
    ],
  },
]

function findSound(id: string): NotificationSound {
  return (
    NOTIFICATION_SOUNDS.find((s) => s.id === id) ??
    NOTIFICATION_SOUNDS.find((s) => s.id === DEFAULT_SOUND_ID) ??
    NOTIFICATION_SOUNDS[0]
  )
}

/** Đọc id âm báo đã chọn từ localStorage; fallback mặc định nếu thiếu/không hợp lệ. */
export function getNotificationSoundId(): string {
  try {
    const stored = readUiPref(SOUND_ID_KEY)
    if (stored && NOTIFICATION_SOUNDS.some((s) => s.id === stored)) return stored
  } catch {
    // localStorage không khả dụng (private mode) — dùng mặc định.
  }
  return DEFAULT_SOUND_ID
}

/** Lưu id âm báo. Bỏ qua giá trị không hợp lệ để tránh ghi rác. */
export function setNotificationSoundId(id: string): void {
  if (!NOTIFICATION_SOUNDS.some((s) => s.id === id)) return
  try {
    writeUiPref(SOUND_ID_KEY, id)
  } catch {
    // ignore
  }
}

/** Lên lịch phát 1 đoạn âm (oscillator + envelope) trên AudioContext cho trước. */
function scheduleSegment(ctx: AudioContext, startAt: number, seg: ToneSegment): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = seg.type ?? 'sine'

  const end = startAt + seg.duration
  osc.frequency.setValueAtTime(seg.freq, startAt)
  if (seg.endFreq != null) {
    osc.frequency.linearRampToValueAtTime(seg.endFreq, end)
  }

  const peak = seg.peak ?? 0.5
  const FADE_IN = 0.008
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(peak, startAt + FADE_IN)
  if (seg.decay) {
    // Bao hình ngân: giảm tuyến tính peak → ~0 suốt độ dài (chuông/pluck).
    gain.gain.linearRampToValueAtTime(0.0001, end)
  } else {
    const FADE_OUT = 0.05
    gain.gain.setValueAtTime(peak, Math.max(startAt + FADE_IN, end - FADE_OUT))
    gain.gain.linearRampToValueAtTime(0, end)
  }

  osc.connect(gain).connect(ctx.destination)
  osc.start(startAt)
  osc.stop(end + 0.02)
}

// Lead nhỏ trước khi phát: KHÔNG schedule node ngay tại `ctx.currentTime` sau
// resume() — vài ms microtask đã trôi qua, browser (đặc biệt iOS Safari) có thể
// bỏ qua/clip âm đầu tiên → "bấm mà không nghe gì". 50ms đủ an toàn, vẫn tức thì.
const SCHEDULE_LEAD_S = 0.05

/**
 * Lên lịch phát toàn bộ âm báo `id` trên AudioContext (giả định context đã
 * `running` — caller resume trước nếu suspended/interrupted).
 */
export function scheduleNotificationSound(ctx: AudioContext, id: string): void {
  const sound = findSound(id)
  const origin = ctx.currentTime + SCHEDULE_LEAD_S
  for (const seg of sound.segments) {
    scheduleSegment(ctx, origin + seg.start, seg)
  }
}
