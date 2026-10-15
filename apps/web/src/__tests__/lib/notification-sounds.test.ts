import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  NOTIFICATION_SOUNDS,
  DEFAULT_SOUND_ID,
  SOUND_ID_KEY,
  getNotificationSoundId,
  setNotificationSoundId,
  scheduleNotificationSound,
} from '@/lib/notification-sounds'

// ──────────────────────────────────────────────────────────────────────────────
// localStorage mock (jsdom có sẵn nhưng ta reset giữa các test)
// ──────────────────────────────────────────────────────────────────────────────
function makeLocalStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
})

describe('notification-sounds — danh sách preset', () => {
  it('mặc định "beep" tồn tại và đứng đầu danh sách', () => {
    expect(DEFAULT_SOUND_ID).toBe('beep')
    expect(NOTIFICATION_SOUNDS[0].id).toBe('beep')
  })

  it('mọi preset có id duy nhất + label + ít nhất 1 đoạn âm', () => {
    const ids = NOTIFICATION_SOUNDS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of NOTIFICATION_SOUNDS) {
      expect(s.label.trim().length).toBeGreaterThan(0)
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(s.segments.length).toBeGreaterThan(0)
      for (const seg of s.segments) {
        expect(seg.freq).toBeGreaterThan(0)
        expect(seg.duration).toBeGreaterThan(0)
      }
    }
  })
})

describe('getNotificationSoundId / setNotificationSoundId', () => {
  it('trả mặc định khi chưa lưu gì', () => {
    expect(getNotificationSoundId()).toBe(DEFAULT_SOUND_ID)
  })

  it('lưu + đọc lại id hợp lệ', () => {
    setNotificationSoundId('chime')
    expect(localStorage.getItem(SOUND_ID_KEY)).toBe('chime')
    expect(getNotificationSoundId()).toBe('chime')
  })

  it('bỏ qua id không hợp lệ khi set', () => {
    setNotificationSoundId('khong-ton-tai')
    expect(localStorage.getItem(SOUND_ID_KEY)).toBeNull()
    expect(getNotificationSoundId()).toBe(DEFAULT_SOUND_ID)
  })

  it('fallback mặc định khi localStorage chứa id rác', () => {
    localStorage.setItem(SOUND_ID_KEY, 'rac-rac')
    expect(getNotificationSoundId()).toBe(DEFAULT_SOUND_ID)
  })
})

describe('scheduleNotificationSound — tạo oscillator + gain cho mỗi đoạn', () => {
  it('tạo đúng số oscillator = tổng số segment của preset', () => {
    const oscStart = vi.fn()
    const oscStop = vi.fn()
    const createOscillator = vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
      start: oscStart,
      stop: oscStop,
    }))
    const createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
    }))
    const ctx = {
      currentTime: 0,
      destination: {},
      createOscillator,
      createGain,
    } as unknown as AudioContext

    const bell = NOTIFICATION_SOUNDS.find((s) => s.id === 'bell')!
    scheduleNotificationSound(ctx, 'bell')

    expect(createOscillator).toHaveBeenCalledTimes(bell.segments.length)
    expect(oscStart).toHaveBeenCalledTimes(bell.segments.length)
    expect(oscStop).toHaveBeenCalledTimes(bell.segments.length)
  })

  it('schedule với LEAD > 0 — tone đầu KHÔNG đặt ngay tại currentTime (chống first-click silent)', () => {
    const oscStart = vi.fn()
    const createOscillator = vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
      start: oscStart,
      stop: vi.fn(),
    }))
    const createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
    }))
    const ctx = {
      currentTime: 10, // mô phỏng clock đã chạy
      destination: {},
      createOscillator,
      createGain,
    } as unknown as AudioContext

    scheduleNotificationSound(ctx, 'beep') // beep: 1 seg, start=0
    // start phải > currentTime (có lead) → KHÔNG đặt ngay tại/đằng sau clock hiện tại.
    expect(oscStart).toHaveBeenCalledTimes(1)
    expect(oscStart.mock.calls[0][0]).toBeGreaterThan(10)
  })

  it('id không hợp lệ → fallback preset mặc định (vẫn phát)', () => {
    const createOscillator = vi.fn(() => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
      start: vi.fn(),
      stop: vi.fn(),
    }))
    const createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(() => ({ connect: vi.fn() })),
    }))
    const ctx = {
      currentTime: 0,
      destination: {},
      createOscillator,
      createGain,
    } as unknown as AudioContext

    const fallback = NOTIFICATION_SOUNDS.find((s) => s.id === DEFAULT_SOUND_ID)!
    scheduleNotificationSound(ctx, 'khong-ton-tai')
    expect(createOscillator).toHaveBeenCalledTimes(fallback.segments.length)
  })
})
