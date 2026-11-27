import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEDUPE_WINDOW_MS,
  MAX_SENDS_PER_PAGE,
  logFrontendEvent,
  resetFeLoggerForTests,
} from '@/lib/fe-logger'

describe('fe-logger chống gửi lặp', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    resetFeLoggerForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('cùng message trong 60 giây chỉ gửi một lần, sau 60 giây gửi lại', () => {
    logFrontendEvent('lỗi A')
    logFrontendEvent('lỗi A')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(DEDUPE_WINDOW_MS + 1)
    logFrontendEvent('lỗi A')
    // lượt đầu còn đang bay (flushing) nên lượt sau xếp hàng chờ; chạy hết hàng đợi
    vi.runAllTimers()
    return Promise.resolve().then(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1))
  })

  it('message khác nhau vẫn gửi, nhưng tối đa 10 lượt mỗi trang', async () => {
    for (let i = 0; i < MAX_SENDS_PER_PAGE + 5; i++) logFrontendEvent(`lỗi ${i}`)
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SENDS_PER_PAGE)
  })
})
