import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import {
  maskPhone,
  logFrontendEvent,
  logFrontendError,
} from '@/lib/fe-logger'

describe('maskPhone — format `xxx-xxx-**67`', () => {
  it('phone VN 10 số: chỉ giữ 2 số cuối, format xxx-xxxx-**XX', () => {
    expect(maskPhone('0912345678')).toBe('xxxx-xxxx-**78')
  })

  it('phone quốc tế 11 số (84xxxxxxxxx): xxxx-xxxxx-**XX', () => {
    expect(maskPhone('84912345678')).toMatch(/^x+-x+-\*\*78$/)
  })

  it('strip dấu phân cách trong input', () => {
    expect(maskPhone('+84 (912) 345-678')).toMatch(/-\*\*78$/)
  })

  it('null / undefined / empty trả "" (không leak)', () => {
    expect(maskPhone(null)).toBe('')
    expect(maskPhone(undefined)).toBe('')
    expect(maskPhone('')).toBe('')
  })

  it('input < 4 chữ số chỉ trả x*length (không có dash + tail)', () => {
    expect(maskPhone('123')).toBe('xxx')
    expect(maskPhone('12')).toBe('xx')
  })

  it('không leak digits ngoài 2 số cuối', () => {
    const masked = maskPhone('0912345678')
    // 8 số đầu (0912345?) phải bị mask
    expect(masked).not.toContain('0912')
    expect(masked).not.toContain('345')
  })
})

describe('logFrontendEvent + logFrontendError — reserved keys không bị override', () => {
  let fetchSpy: MockInstance<typeof globalThis.fetch>

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true } as Response)
  })

  function getLastBody(): Record<string, unknown> {
    const calls = fetchSpy.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const init = calls[calls.length - 1][1] as RequestInit
    return JSON.parse(init.body as string)
  }

  it('logFrontendEvent: extra.level KHÔNG override level explicit', async () => {
    logFrontendEvent('test', {
      level: 'warn',
      extra: { level: 'error' as unknown as 'info', secs: 5 },
    })
    await new Promise((r) => setTimeout(r, 50))
    const body = getLastBody()
    expect(body.level).toBe('warn')
    expect(body.secs).toBe(5)
  })

  it('logFrontendError: extra.message KHÔNG override err.message', async () => {
    logFrontendError(new Error('real error'), { message: 'fake', component: 'x' })
    await new Promise((r) => setTimeout(r, 50))
    const body = getLastBody()
    expect(body.message).toBe('real error')
    expect(body.component).toBe('x')
  })

  it('logFrontendEvent: extra spread phẳng (top-level keys)', async () => {
    logFrontendEvent('slow_load', {
      level: 'warn',
      component: 'list-view',
      extra: { secs: 4, phone: 'xxxx-xxxx-**78', item_id: '123' },
    })
    await new Promise((r) => setTimeout(r, 50))
    const body = getLastBody()
    expect(body.secs).toBe(4)
    expect(body.phone).toBe('xxxx-xxxx-**78')
    expect(body.item_id).toBe('123')
    // KHÔNG có nested `extra` object
    expect(body.extra).toBeUndefined()
  })
})
