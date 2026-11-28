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

function toLoginResult(data: LoginResponseRaw): LoginResult {
  return {
    user: data.user,
    roles: data.roles,
    permissions: data.permissions,
    isAdmin: data.isAdmin,
    company: data.company,
    tokens: { accessToken: data.access_token, refreshToken: data.refresh_token },
  }
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/login', { email, password })
  return toLoginResult(data)
}

// ── Đăng nhập không mật khẩu (#675) ─────────────────────────────────────────

/** `GET /auth/methods`: cách đăng nhập bản cài đặt này bật (thiếu SMTP ⇒ không có email, thiếu Google ⇒ không có nút). */
export interface LoginMethods {
  email_login_enabled: boolean
  google_enabled: boolean
  password_login_enabled: boolean
  signup_enabled: boolean
  code_length: number
  resend_after: number
  expires_in: number
}

/** Máy chủ chưa có route (bản cũ) hoặc lỗi mạng ⇒ `null`: màn đăng nhập về form mật khẩu như cũ. */
export async function getLoginMethods(): Promise<LoginMethods | null> {
  try {
    const { data } = await apiClient.get<LoginMethods>('/auth/methods')
    return data && typeof data.email_login_enabled === 'boolean' ? data : null
  } catch {
    return null
  }
}

export interface EmailStartResult {
  message: string
  /** Email đã che: `a***@gmail.com`. */
  email: string
  expires_in: number
  resend_after: number
}

/** Gửi mã 6 số + link tới email. Luôn trả như nhau dù email có tài khoản hay không. */
export async function startEmailLogin(email: string): Promise<EmailStartResult> {
  const { data } = await apiClient.post<EmailStartResult>('/auth/email/start', { email })
  return data
}

export async function verifyEmailCode(email: string, code: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/email/verify', { email, code })
  return toLoginResult(data)
}

/** Link trong thư: `/auth/email#token=…`. */
export async function redeemEmailLink(token: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/email/callback', { token })
  return toLoginResult(data)
}

/** Vé một lần sau Google: `/auth/complete#ticket=…`. */
export async function redeemLoginTicket(ticket: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/ticket', { ticket })
  return toLoginResult(data)
}

/** Địa chỉ bắt đầu đăng nhập Google (điều hướng cả trang, máy chủ chuyển sang Google). */
export function googleStartUrl(next?: string | null): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : ''
  return `/api/v1/auth/google/start${q}`
}

/** Gửi mã xác nhận tới email của lời mời. */
export async function sendInvitationCode(token: string): Promise<{ email: string; expires_in: number; resend_after: number }> {
  const { data } = await apiClient.post<{ email: string; expires_in: number; resend_after: number }>(
    '/auth/invitations/send-code',
    { token },
  )
  return data
}

/** Nhận lời mời bằng mã email (không cần mật khẩu). */
export async function acceptInvitationWithCode(input: { token: string; full_name: string; code: string }): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/invitations/accept', input)
  return toLoginResult(data)
}

/** Cài đặt › Tài khoản. */
export interface AccountOverview {
  has_password: boolean
  identities: { provider: string; email: string | null; created_at: string; last_login_at: string | null }[]
  email_login_enabled: boolean
  google_enabled: boolean
  password_login_enabled: boolean
}

export async function getAccount(): Promise<AccountOverview> {
  const { data } = await apiClient.get<AccountOverview>('/auth/account')
  return data
}

/** Bắt đầu liên kết Google cho tài khoản đang đăng nhập: trả URL Google (máy chủ đặt cookie state). */
export async function startGoogleLink(next: string): Promise<string> {
  const { data } = await apiClient.post<{ url: string }>('/auth/google/link', { next })
  return data.url
}

export async function unlinkGoogle(): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>('/auth/account/identities/google')
  return data
}

export async function setAccountPassword(input: { new_password: string; current_password?: string }): Promise<{ message: string }> {
  const { data } = await apiClient.put<{ message: string }>('/auth/account/password', input)
  return data
}

export async function removeAccountPassword(current_password: string): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>('/auth/account/password', { data: { current_password } })
  return data
}

export interface RegisterInput {
  company_name: string
  full_name: string
  email: string
  password: string
}

/** Sign-up (multi-tenant installs): creates a new company owned by this account and returns a logged-in session. */
export async function registerCompany(input: RegisterInput): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/register', input)
  return toLoginResult(data)
}

export interface InvitationPreview {
  company_name: string
  email: string
  role_name: string | null
  expires_at: string
}

/** Trang nhận lời mời (công khai): ai mời, vào công ty nào, vai trò gì. 410 = link hết hạn/đã dùng/đã huỷ. */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const { data } = await apiClient.post<InvitationPreview>('/auth/invitations/preview', { token })
  return data
}

/** Nhận lời mời: tạo tài khoản trong công ty của lời mời và đăng nhập luôn. */
export async function acceptInvitation(input: { token: string; full_name: string; password: string }): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResponseRaw>('/auth/invitations/accept', input)
  return {
    user: data.user,
    roles: data.roles,
    permissions: data.permissions,
    isAdmin: data.isAdmin,
    company: data.company,
    tokens: { accessToken: data.access_token, refreshToken: data.refresh_token },
  }
}

export async function isSignupEnabled(): Promise<boolean> {
  try {
    const { data } = await apiClient.get<{ enabled: boolean }>('/auth/signup-enabled')
    return data.enabled === true
  } catch {
    return false
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
