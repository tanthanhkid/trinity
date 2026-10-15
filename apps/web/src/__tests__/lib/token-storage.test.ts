import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getAccessToken,
  setAccessToken,
  getRefreshToken,
  setRefreshToken,
  clearTokens,
} from '@/lib/token-storage'

const ACCESS_KEY = 'trinity_access_token'
const REFRESH_KEY = 'trinity_refresh_token'
const COOKIE_ACCESS_TOKEN = 'access_token'

// ──────────────────────────────────────────────────────────────────────────────
// localStorage mock — mirror `notification-sounds.test.ts`. Node 22+/26 định
// nghĩa sẵn `globalThis.localStorage` (Web Storage API thử nghiệm, yêu cầu
// flag `--localstorage-file`) và nó THẮNG shim của jsdom trong môi trường này
// (đo thật: `localStorage.clear()` trần ném "Cannot read properties of
// undefined" dù `vitest.config.ts` đã set `environment: 'jsdom'`) — nên PHẢI
// tự stub global `localStorage` bằng `vi.stubGlobal`, không dựa vào jsdom.
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
  // jsdom giữ cookie giữa các test trong cùng file — dọn sạch để test không
  // dính trạng thái của nhau (mirror clearTokens: đặt max-age=0).
  document.cookie = `${COOKIE_ACCESS_TOKEN}=; path=/; max-age=0`
  document.cookie = `has_session=; path=/; max-age=0`
})

describe('token-storage', () => {
  it('không có key nào (chưa đăng nhập) → trả null', () => {
    expect(getAccessToken()).toBeNull()
    expect(getRefreshToken()).toBeNull()
  })

  it('setAccessToken/setRefreshToken ghi đúng key + cookie', () => {
    setAccessToken('tok-a')
    setRefreshToken('tok-r')

    expect(localStorage.getItem(ACCESS_KEY)).toBe('tok-a')
    expect(localStorage.getItem(REFRESH_KEY)).toBe('tok-r')
    expect(getAccessToken()).toBe('tok-a')
    expect(getRefreshToken()).toBe('tok-r')
    expect(document.cookie).toContain(`${COOKIE_ACCESS_TOKEN}=tok-a`)
    expect(document.cookie).toContain('has_session=1')
  })

  it('clearTokens(): xoá sạch cả 2 key + cookie', () => {
    setAccessToken('tok-a')
    setRefreshToken('tok-r')

    clearTokens()

    expect(localStorage.getItem(ACCESS_KEY)).toBeNull()
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull()
    expect(document.cookie).not.toContain(`${COOKIE_ACCESS_TOKEN}=tok-a`)
    expect(document.cookie).not.toContain('has_session=1')
  })
})
