import apiClient from './api-client'
import { clearTokens, setAccessToken, setRefreshToken, getAccessToken, getRefreshToken } from './token-storage'
import type { AuthMe, AuthTokens } from '../types/auth'

// 🔴 RBAC quyền + phạm vi — BE trả `{ user, roles, permissions, isAdmin }`
// cho CẢ `/auth/me` LẪN login/refresh (xem `services/auth/src/auth/auth.service.ts`
// `toMeResponse()`). BE không gửi `role` đơn lẻ nên FE không alias vai trò.
interface LoginResponseRaw extends AuthMe {
  access_token: string
  refresh_token: string
}

export interface LoginResult extends AuthMe {
  tokens: AuthTokens
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/login', { email, password })
  return {
    user: data.user,
    roles: data.roles,
    permissions: data.permissions,
    isAdmin: data.isAdmin,
    tokens: { accessToken: data.access_token, refreshToken: data.refresh_token },
  }
}

export async function getMe(): Promise<AuthMe> {
  const { data } = await apiClient.get<AuthMe>('/auth/me')
  return data
}

export async function refreshToken(token: string): Promise<AuthTokens> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/refresh', {
    refresh_token: token,
  })
  const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token }
  setAccessToken(tokens.accessToken)
  setRefreshToken(tokens.refreshToken)
  return tokens
}

export async function logout(clearAuth: () => void): Promise<void> {
  // Await server thu hồi phiên (gửi kèm refresh token) trước khi clearTokens để Authorization header còn hợp lệ
  const token = getAccessToken()
  if (token) {
    try {
      await apiClient.post('/auth/logout', { refresh_token: getRefreshToken() ?? undefined })
    } catch {
      // Server unreachable — tokens sẽ tự hết hạn (15m access, 7d refresh)
    }
  }
  clearTokens()
  clearAuth()
}
