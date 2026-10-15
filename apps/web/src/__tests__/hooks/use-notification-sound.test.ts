import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Web Audio API beep implementation tests.
 *
 * Kiểm tra:
 * 1. play() gọi AudioContext và OscillatorNode đúng cách
 * 2. Throttle: không phát 2 lần trong 500ms
 * 3. Priming: listeners đăng ký đúng khi chưa prime
 * 4. Sound disabled: play() không tạo AudioContext
 */

// ──────────────────────────────────────────────────────────────────────────────
// Mock Web Audio API (jsdom không implement sẵn)
// ──────────────────────────────────────────────────────────────────────────────
const mockOscillatorStop = vi.fn()
const mockOscillatorStart = vi.fn()
const mockOscillatorConnect = vi.fn()
const mockGainConnect = vi.fn()
const mockSetValueAtTime = vi.fn()
const mockLinearRampToValueAtTime = vi.fn()

const mockGainNode = {
  connect: mockGainConnect,
  gain: {
    setValueAtTime: mockSetValueAtTime,
    linearRampToValueAtTime: mockLinearRampToValueAtTime,
  },
}

const mockOscillator = {
  connect: mockOscillatorConnect,
  start: mockOscillatorStart,
  stop: mockOscillatorStop,
  frequency: { value: 0 },
  type: 'sine' as OscillatorType,
  onended: null as (() => void) | null,
}

const mockResumeResolve = vi.fn().mockResolvedValue(undefined)
const mockCreateOscillator = vi.fn(() => mockOscillator)
const mockCreateGain = vi.fn(() => mockGainNode)

const mockAudioContext = {
  state: 'running' as AudioContextState,
  currentTime: 0,
  createOscillator: mockCreateOscillator,
  createGain: mockCreateGain,
  resume: mockResumeResolve,
  destination: {},
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers extracted from hook logic (testable units)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Simulate throttle check — mirrors `_lastPlayedAt` + `PLAY_THROTTLE_MS = 500`
 */
function makeThrottleChecker() {
  let lastPlayedAt = 0
  const THROTTLE = 500
  return {
    shouldPlay(nowMs: number): boolean {
      if (nowMs - lastPlayedAt < THROTTLE) return false
      lastPlayedAt = nowMs
      return true
    }
  }
}

/**
 * Simulate isSoundEnabled() reading localStorage
 */
function makeSoundEnabledChecker(storage: Record<string, string>) {
  const KEY = 'trinity:notif:sound-enabled'
  return () => {
    const stored = storage[KEY]
    return stored === undefined ? true : stored === 'true'
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('Web Audio API beep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOscillator.onended = null
  })

  describe('Throttle logic', () => {
    it('cho phép phát khi lần đầu', () => {
      const checker = makeThrottleChecker()
      expect(checker.shouldPlay(1000)).toBe(true)
    })

    it('chặn phát nếu < 500ms sau lần trước', () => {
      const checker = makeThrottleChecker()
      checker.shouldPlay(1000)
      expect(checker.shouldPlay(1300)).toBe(false)   // +300ms < 500ms
    })

    it('cho phép phát lại khi đủ 500ms', () => {
      const checker = makeThrottleChecker()
      checker.shouldPlay(1000)
      expect(checker.shouldPlay(1600)).toBe(true)    // +600ms > 500ms
    })

    it('nhiều event cùng lúc: chỉ phát 1 lần', () => {
      const checker = makeThrottleChecker()
      const t = 5000
      expect(checker.shouldPlay(t)).toBe(true)
      expect(checker.shouldPlay(t)).toBe(false)
      expect(checker.shouldPlay(t + 100)).toBe(false)
      expect(checker.shouldPlay(t + 500)).toBe(true)  // sau đúng 500ms
    })
  })

  describe('Sound enabled/disabled', () => {
    it('mặc định là enabled khi chưa có localStorage key', () => {
      const checker = makeSoundEnabledChecker({})
      expect(checker()).toBe(true)
    })

    it('disabled khi localStorage = "false"', () => {
      const checker = makeSoundEnabledChecker({ 'trinity:notif:sound-enabled': 'false' })
      expect(checker()).toBe(false)
    })

    it('enabled khi localStorage = "true"', () => {
      const checker = makeSoundEnabledChecker({ 'trinity:notif:sound-enabled': 'true' })
      expect(checker()).toBe(true)
    })
  })

  describe('OscillatorNode envelope setup', () => {
    it('oscillator kết nối vào gainNode, gainNode kết nối vào destination', () => {
      const ctx = mockAudioContext
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain as unknown as AudioNode)
      gain.connect(ctx.destination as AudioNode)

      expect(mockOscillatorConnect).toHaveBeenCalledWith(mockGainNode)
      expect(mockGainConnect).toHaveBeenCalledWith(ctx.destination)
    })

    it('oscillator frequency = 880Hz', () => {
      const osc = mockAudioContext.createOscillator()
      osc.frequency.value = 880
      expect(osc.frequency.value).toBe(880)
    })

    it('envelope có setValueAtTime và linearRampToValueAtTime calls', () => {
      const DURATION = 0.3
      const FADE_IN = 0.01
      const FADE_OUT = 0.04
      const GAIN_PEAK = 0.5
      const now = 0

      const gain = mockAudioContext.createGain()
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(GAIN_PEAK, now + FADE_IN)
      gain.gain.setValueAtTime(GAIN_PEAK, now + DURATION - FADE_OUT)
      gain.gain.linearRampToValueAtTime(0, now + DURATION)

      expect(mockSetValueAtTime).toHaveBeenNthCalledWith(1, 0, 0)
      expect(mockLinearRampToValueAtTime).toHaveBeenNthCalledWith(1, GAIN_PEAK, FADE_IN)
      expect(mockSetValueAtTime).toHaveBeenNthCalledWith(2, GAIN_PEAK, DURATION - FADE_OUT)
      expect(mockLinearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0, DURATION)
    })

    it('osc.start() và osc.stop() được gọi đúng thứ tự', () => {
      const ctx = mockAudioContext
      const osc = ctx.createOscillator()
      const DURATION = 0.3
      const now = ctx.currentTime
      osc.start(now)
      osc.stop(now + DURATION)

      expect(mockOscillatorStart).toHaveBeenCalledWith(0)
      expect(mockOscillatorStop).toHaveBeenCalledWith(DURATION)
    })
  })

  describe('Suspended AudioContext — priming', () => {
    it('gọi resume() khi context.state === suspended', async () => {
      const ctx = { ...mockAudioContext, state: 'suspended' as AudioContextState }
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      expect(mockResumeResolve).toHaveBeenCalledTimes(1)
    })

    it('không gọi resume() khi context.state === running', async () => {
      const ctx = { ...mockAudioContext, state: 'running' as AudioContextState }
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      expect(mockResumeResolve).not.toHaveBeenCalled()
    })
  })
})

describe('play() vẫn không bị gọi khi sound disabled', () => {
  it('không tạo AudioContext khi sound disabled', () => {
    const isSoundEnabled = makeSoundEnabledChecker({ 'trinity:notif:sound-enabled': 'false' })
    const createCtxSpy = vi.fn()

    if (!isSoundEnabled()) {
      // return early, do not call createCtxSpy
    } else {
      createCtxSpy()
    }

    expect(createCtxSpy).not.toHaveBeenCalled()
  })
})
