import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()
vi.mock('@/lib/api-client', () => ({ default: { post: (...a: unknown[]) => post(...a) } }))

let access: string | null = null
let refresh: string | null = null
const clearTokens = vi.fn()
vi.mock('@/lib/token-storage', () => ({
  getAccessToken: () => access,
  getRefreshToken: () => refresh,
  setAccessToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearTokens: () => clearTokens(),
}))

import { logout } from '@/lib/auth-api'

describe('logout — thu hồi phiên phía máy chủ', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({})
    clearTokens.mockClear()
  })

  it('gửi kèm refresh token của phiên hiện tại để máy chủ thu hồi, rồi mới xoá token cục bộ', async () => {
    access = 'a'
    refresh = 'r-token'
    const clearAuth = vi.fn()
    await logout(clearAuth)
    expect(post).toHaveBeenCalledWith('/auth/logout', { refresh_token: 'r-token' })
    expect(clearTokens).toHaveBeenCalled()
    expect(clearAuth).toHaveBeenCalled()
  })

  it('máy chủ không với tới được vẫn đăng xuất cục bộ', async () => {
    access = 'a'
    refresh = 'r'
    post.mockRejectedValue(new Error('offline'))
    const clearAuth = vi.fn()
    await logout(clearAuth)
    expect(clearTokens).toHaveBeenCalled()
    expect(clearAuth).toHaveBeenCalled()
  })
})
