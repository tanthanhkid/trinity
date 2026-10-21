import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import type { Grants } from '@trinity/rbac'
import {
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
  clearTokens,
} from './token-storage'
import { logFrontendError } from './fe-logger'
import type { AuthMe, Role, User } from '../types/auth'

// Use relative URL so Next.js rewrites proxy to remote backend (avoids CORS in local dev)
// In production, NEXT_PUBLIC_API_URL is set to absolute URL directly
const BASE_URL = typeof window !== 'undefined'
  ? '/api/v1'
  : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1')

const AUTH_SKIP_URLS = ['/auth/login', '/auth/refresh']

// 🔴 RBAC quyền + phạm vi — `/auth/refresh` nay trả THÊM
// `user`/`roles`/`permissions`/`isAdmin` (spec §5.2, cùng shape login/`/auth/me`)
// để FE có quyền mới ngay mà không cần gọi thêm request. 4 field đó khai
// OPTIONAL — cửa sổ deploy web-trước-auth có thể còn gặp response CŨ (chỉ
// token), khi đó giữ nguyên `permissions`/`roles`/`isAdmin` đang có trong
// store (KHÔNG ép về rỗng).
interface RefreshResponse {
  accessToken: string
  refreshToken: string
  user?: User
  roles?: Role[]
  permissions?: Grants
  isAdmin?: boolean
}

type FailedQueueItem = {
  resolve: (token: string) => void
  reject: (error: unknown) => void
}

let isRefreshing = false
let isLoggingOut = false
let failedQueue: FailedQueueItem[] = []

function forceLogout(): void {
  if (isLoggingOut) return
  isLoggingOut = true
  const doRedirect = (): void => {
    clearTokens()
    if (typeof window !== 'undefined') {
      window.location.replace('/login')
    }
  }
  doRedirect()
}

const REFRESH_MAX_ATTEMPTS = 3
const REFRESH_RETRY_BASE_MS = 400

/**
 * Gia hạn token, RETRY khi lỗi tạm thời (mất mạng / 5xx / timeout). Chỉ ném lỗi
 * (→ forceLogout) khi refresh token thực sự không hợp lệ (401/403) hoặc đã hết
 * lượt thử. Tránh đá user ra login chỉ vì 1 lần trục trặc mạng giữa chừng.
 */
async function refreshTokens(refreshToken: string): Promise<RefreshResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt++) {
    try {
      const { data } = await axios.post<RefreshResponse>(
        `${BASE_URL}/auth/refresh`,
        { refresh_token: refreshToken },
      )
      return data
    } catch (err) {
      lastError = err
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      if (status === 401 || status === 403) throw err
      if (attempt < REFRESH_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, REFRESH_RETRY_BASE_MS * (attempt + 1)))
      }
    }
  }
  throw lastError
}

/** Reset the logout guard so a fresh login can make API calls again. */
function resetLogoutState(): void {
  isLoggingOut = false
}

/**
 * Dựng lại `AuthMe` từ response `/auth/refresh` — ưu tiên `user`/`roles`/
 * `permissions`/`isAdmin` MỚI (BE nay trả kèm, spec §5.2); response CŨ (cửa sổ
 * deploy lệch version, chỉ có token) → giữ NGUYÊN state hiện có trong store
 * thay vì ép về rỗng. `null` khi store CŨNG chưa có user (chưa từng đăng nhập
 * trong phiên này) — khi đó không gọi `setAuth`, chỉ cập nhật token.
 */
function resolveRefreshedAuthMe(
  data: RefreshResponse,
  current: { user: User | null; roles: Role[]; permissions: Grants; isAdmin: boolean },
): AuthMe | null {
  const user = data.user ?? current.user
  if (!user) return null
  return {
    user,
    roles: data.roles ?? current.roles,
    permissions: data.permissions ?? current.permissions,
    isAdmin: data.isAdmin ?? current.isAdmin,
  }
}

function processQueue(error: unknown, token: string | null): void {
  failedQueue.forEach((item) => {
    if (error) {
      item.reject(error)
    } else if (token) {
      item.resolve(token)
    }
  })
  failedQueue = []
}

/**
 * Gia hạn access token CHỦ ĐỘNG (proactive) rồi lưu vào storage + Zustand.
 *
 * Dùng CHUNG guard `isRefreshing`/`failedQueue` với response interceptor → khi
 * scheduler (proactive) và interceptor (reactive 401) cùng muốn refresh, chỉ 1
 * lần gọi `/auth/refresh` thực sự chạy; bên còn lại chờ qua hàng đợi (tránh race
 * xoay refresh token → đăng xuất oan).
 *
 * KHÔNG tự `forceLogout` — caller (scheduler) NUỐT lỗi. Việc đăng xuất khi refresh
 * token thật sự hết hạn vẫn do interceptor reactive quyết định.
 *
 * Mục đích: request KHÔNG đi qua axios interceptor (vd `fetch()` thô)
 * luôn đọc được token còn hiệu lực → diệt lỗi 401 "Token hết hạn" rải rác.
 */
async function performTokenRefresh(): Promise<string> {
  if (isLoggingOut) throw new Error('Đang đăng xuất')
  if (isRefreshing) {
    // Một refresh đang chạy → chờ kết quả qua hàng đợi chung (KHÔNG gọi lại).
    return new Promise<string>((resolve, reject) => {
      failedQueue.push({ resolve, reject })
    })
  }
  isRefreshing = true
  try {
    const currentRefreshToken = getRefreshToken()
    if (!currentRefreshToken) throw new Error('No refresh token')
    const data = await refreshTokens(currentRefreshToken)
    const newAccessToken =
      data.accessToken ?? (data as unknown as Record<string, string>).access_token
    const newRefreshToken =
      data.refreshToken ?? (data as unknown as Record<string, string>).refresh_token
    if (!newAccessToken) throw new Error('Invalid refresh response')
    setAccessToken(newAccessToken)
    if (newRefreshToken) setRefreshToken(newRefreshToken)
    const { useAuthStore } = await import('../store/auth')
    const current = useAuthStore.getState()
    const tokens = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken ?? currentRefreshToken,
    }
    const authMe = resolveRefreshedAuthMe(data, current)
    if (authMe) {
      useAuthStore.getState().setAuth(authMe, tokens)
    } else {
      useAuthStore.setState(tokens)
    }
    processQueue(null, newAccessToken)
    return newAccessToken
  } catch (err) {
    processQueue(err, null)
    throw err
  } finally {
    isRefreshing = false
  }
}

const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
    // Block all requests once logout is triggered
    if (isLoggingOut) {
      const controller = new AbortController()
      controller.abort()
      config.signal = controller.signal
      return config
    }
    // Mặc định JSON khiến axios biến FormData thành JSON (máy chủ báo "Thiếu tệp"): tệp luôn đi multipart, trình duyệt tự gắn boundary.
    if (typeof FormData !== 'undefined' && config.data instanceof FormData) config.headers.set('Content-Type', 'multipart/form-data')
    const url = config.url ?? ''
    const isAuthSkip = AUTH_SKIP_URLS.some((skip) => url.includes(skip))
    if (!isAuthSkip) {
      const token = getAccessToken()
      if (token) {
        config.headers.set('Authorization', `Bearer ${token}`)
      }
    }
    return config
  },
  (error: unknown) => Promise.reject(error),
)

apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: unknown) => {
    if (isLoggingOut) return Promise.reject(error)
    if (!axios.isAxiosError(error)) return Promise.reject(error)

    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error)
    }

    const url = originalRequest.url ?? ''
    if (url.includes('/auth/refresh')) {
      forceLogout()
      return Promise.reject(error)
    }
    if (url.endsWith('/auth/login')) {
      return Promise.reject(error)
    }

    if (isRefreshing) {
      return new Promise<AxiosResponse>((resolve, reject) => {
        failedQueue.push({
          resolve: (token: string) => {
            originalRequest.headers.set('Authorization', `Bearer ${token}`)
            resolve(apiClient(originalRequest))
          },
          reject,
        })
      })
    }

    originalRequest._retry = true
    isRefreshing = true

    try {
      const currentRefreshToken = getRefreshToken()
      if (!currentRefreshToken) {
        throw new Error('No refresh token')
      }
      const data = await refreshTokens(currentRefreshToken)
      const newAccessToken = data.accessToken ?? (data as unknown as Record<string, string>).access_token
      const newRefreshToken = data.refreshToken ?? (data as unknown as Record<string, string>).refresh_token
      if (!newAccessToken) {
        throw new Error('Invalid refresh response')
      }
      setAccessToken(newAccessToken)
      if (newRefreshToken) setRefreshToken(newRefreshToken)
      // Sync refreshed tokens to Zustand store so UI stays in sync
      const { useAuthStore } = await import('../store/auth')
      const current = useAuthStore.getState()
      const authMe = resolveRefreshedAuthMe(data, current)
      if (authMe) {
        useAuthStore.getState().setAuth(authMe, {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken ?? currentRefreshToken,
        })
      } else {
        useAuthStore.setState({ accessToken: newAccessToken, refreshToken: newRefreshToken ?? currentRefreshToken })
      }
      processQueue(null, newAccessToken)
      originalRequest.headers.set('Authorization', `Bearer ${newAccessToken}`)
      return apiClient(originalRequest)
    } catch (refreshError) {
      logFrontendError(refreshError, {
        component: 'api-client',
        context: 'token-refresh',
        originalUrl: originalRequest.url,
      })
      processQueue(refreshError, null)
      forceLogout()
      return Promise.reject(refreshError)
    } finally {
      isRefreshing = false
    }
  },
)

/**
 * Gửi một lệnh lúc trang đang đóng (`pagehide`): XHR của axios có thể bị trình duyệt huỷ giữa chừng,
 * `fetch` với `keepalive` thì được phép chạy tiếp sau khi tab đóng. Không chờ kết quả.
 */
export function sendKeepalive(method: "DELETE" | "POST" | "PATCH", path: string): void {
  try {
    const token = getAccessToken()
    void fetch(`${BASE_URL}${path}`, {
      method,
      keepalive: true,
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }).catch(() => {})
  } catch {
    /* môi trường không có fetch: bỏ qua, lệnh sẽ không gửi */
  }
}

/** Yêu cầu không tới được máy chủ (mất mạng, máy chủ không phản hồi). */
export const NETWORK_ERROR_MESSAGE = "Không kết nối được máy chủ. Kiểm tra Internet rồi thử lại."
/** Máy chủ phản hồi quá lâu. */
export const TIMEOUT_MESSAGE = "Máy chủ phản hồi quá lâu. Thử lại sau ít phút."

/**
 * Trích thông điệp lỗi tiếng Việt từ axios error.
 * Một số endpoint trả `{ error }`, NestJS trả `{ message }` — fallback nếu không có.
 */
export function getApiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    // Không có phản hồi = yêu cầu không tới được máy chủ: nói rõ nguyên nhân + cách sửa thay vì câu chung chung.
    if (!err.response && err.code !== "ERR_CANCELED") {
      if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") return TIMEOUT_MESSAGE
      return NETWORK_ERROR_MESSAGE
    }
    const data = err.response?.data as
      | { error?: string; message?: string | string[] }
      | undefined
    // ValidationPipe của NestJS trả `message` là mảng — gộp lại để luôn trả string.
    const msg = Array.isArray(data?.message) ? data.message.join("; ") : data?.message
    // NestJS đặt `error` là tên mã HTTP ("Bad Request") — câu giải thích tiếng Việt nằm ở `message`.
    const reason = typeof data?.error === "string" && /^[A-Za-z ]+$/.test(data.error)
    return (reason ? msg ?? data?.error : data?.error ?? msg) ?? fallback
  }
  return fallback
}

export { forceLogout, resetLogoutState, refreshTokens, performTokenRefresh }
export default apiClient
