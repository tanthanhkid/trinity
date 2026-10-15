import { describe, test, expect, afterEach } from 'vitest'
import { readUiPref, writeUiPref, removeUiPref } from '@/lib/ui-pref-storage'

/**
 * Khoá tuỳ chọn UI tiền tố `trinity:`.
 */

function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  }
}

function install(store: ReturnType<typeof fakeStore>) {
  Object.defineProperty(window, 'localStorage', { value: store, configurable: true, writable: true })
}

const ORIGINAL = window.localStorage

afterEach(() => {
  Object.defineProperty(window, 'localStorage', { value: ORIGINAL, configurable: true, writable: true })
})

describe('readUiPref', () => {
  test('đọc đúng giá trị đã lưu', () => {
    install(fakeStore({ 'trinity:notif:sound-id': 'chime' }))
    expect(readUiPref('trinity:notif:sound-id')).toBe('chime')
  })

  test('không có khoá → null', () => {
    install(fakeStore())
    expect(readUiPref('trinity:notif:sound-id')).toBeNull()
  })

  test('localStorage bị chặn hoàn toàn (getItem throw) → null, KHÔNG ném ra ngoài', () => {
    const s = fakeStore()
    s.getItem = (_k: string): string | null => {
      throw new Error('SecurityError')
    }
    install(s)
    expect(() => readUiPref('trinity:notif:sound-id')).not.toThrow()
    expect(readUiPref('trinity:notif:sound-id')).toBeNull()
  })
})

describe('writeUiPref / removeUiPref', () => {
  test('write ghi đúng khoá', () => {
    const s = fakeStore()
    install(s)
    writeUiPref('trinity:notif:sound-id', 'bell')
    expect(s._map.get('trinity:notif:sound-id')).toBe('bell')
  })

  test('write khi storage bị chặn → không ném', () => {
    const s = fakeStore()
    s.setItem = (_k: string, _v: string): undefined => {
      throw new Error('blocked')
    }
    install(s)
    expect(() => writeUiPref('trinity:notif:sound-id', 'bell')).not.toThrow()
  })

  test('remove xoá đúng khoá', () => {
    const s = fakeStore({ 'trinity:notif:sound-id': 'a' })
    install(s)
    removeUiPref('trinity:notif:sound-id')
    expect(s._map.has('trinity:notif:sound-id')).toBe(false)
  })
})
