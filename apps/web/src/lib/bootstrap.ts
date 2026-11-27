import apiClient from './api-client'
import { getAccessToken } from './token-storage'
import { todayVn } from './format'
import { periodRange } from '@/app/(dashboard)/dashboard/_components/command-center-utils'

/**
 * `GET /bootstrap`: máy chủ gộp các lời gọi layout/app-shell (và, ở trang Tổng quan, các khối của trang) thành MỘT lượt.
 * Mỗi khoá là phản hồi y nguyên của endpoint gốc, hoặc `null` khi phần đó lỗi/thiếu quyền.
 *
 * Cách dùng KHÔNG đổi component: `queryFn` cũ bọc bằng `fromBootstrap(khoá, gọiCũ)`. Lời gọi đầu tiên nạp bootstrap (mọi
 * `queryFn` đang chờ dùng chung một lượt), lấy giá trị đúng khoá một LẦN; giá trị thiếu/lỗi/quá cũ ⇒ gọi endpoint gốc như trước
 * (máy chủ cũ chưa có route cũng rơi về đường này). Lượt refetch/poll sau đó luôn đi thẳng endpoint gốc.
 */
export type BootstrapKey =
  | 'me'
  | 'pinned_menu'
  | 'client_ip_alerts'
  | 'channel_guard_alerts'
  | 'telemetry_identity'
  | 'unread_profile'
  | 'unread_message'
  | 'org_features'
  | 'setup_status'
  | 'site_config'
  | 'dashboard_overview'
  | 'dashboard_tasks'
  | 'dashboard_channels'
  | 'dashboard_filter_roster'
  | 'dashboard_command_center'
  | 'ai_actions_home'
  | 'ai_actions_pending'
  | 'notifications_home_unread'

type Payload = Partial<Record<BootstrapKey, unknown>>

/** Giá trị bootstrap chỉ dùng được trong khoảng này sau khi về (quá hạn ⇒ gọi lại endpoint gốc cho tươi). */
const MAX_AGE_MS = 15_000
/** Sau một lần lỗi (vd máy chủ chưa có route), không thử lại trong khoảng này. */
const RETRY_AFTER_FAIL_MS = 5 * 60_000

interface Load {
  token: string
  promise: Promise<Payload | null>
  loadedAt: number
  used: Set<BootstrapKey>
}

let current: Load | null = null
let failedAt = 0

function wantsDashboard(): boolean {
  return typeof window !== 'undefined' && /^\/dashboard\/?$/.test(window.location.pathname)
}

function buildUrl(): string {
  const q = new URLSearchParams()
  if (wantsDashboard()) {
    q.set('include', 'dashboard')
    // Khoảng mặc định của Trung tâm điều hành (kỳ '7d' như `dashboard-home.tsx`); khác kỳ thì hook tự gọi riêng.
    const { from, to } = periodRange('7d', todayVn())
    q.set('cc_from', from)
    q.set('cc_to', to)
  }
  const s = q.toString()
  return s ? `/bootstrap?${s}` : '/bootstrap'
}

function load(): Load | null {
  let token: string | null = null
  try {
    token = getAccessToken()
  } catch {
    // Kho trình duyệt bị chặn: coi như chưa có phiên, các queryFn tự gọi endpoint gốc.
  }
  if (!token) return null
  if (current && current.token === token) return current
  if (Date.now() - failedAt < RETRY_AFTER_FAIL_MS) return null
  const state: Load = { token, promise: Promise.resolve(null), loadedAt: 0, used: new Set() }
  state.promise = (async () => {
    try {
      const res = await apiClient.get<unknown>(buildUrl())
      const d = res?.data
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('bootstrap: body lạ')
      state.loadedAt = Date.now()
      return d as Payload
    } catch {
      failedAt = Date.now()
      if (current === state) current = null
      return null
    }
  })()
  current = state
  return state
}

/**
 * Giá trị của `key` từ bootstrap (một lần), hoặc `fallback()` nếu không có.
 * `pick` đổi phản hồi thô sang dạng queryFn trả (vd `{count}` → số); trả `undefined` = không dùng được.
 */
export async function fromBootstrap<T>(
  key: BootstrapKey,
  fallback: () => Promise<T>,
  pick?: (raw: unknown) => T | undefined,
): Promise<T> {
  const state = load()
  if (state) {
    const data = await state.promise
    const raw = data?.[key]
    if (raw != null && !state.used.has(key) && Date.now() - state.loadedAt < MAX_AGE_MS) {
      const v = pick ? pick(raw) : (raw as T)
      if (v !== undefined) {
        state.used.add(key)
        return v
      }
    }
  }
  return fallback()
}

/** Chỉ cho test: xoá trạng thái nhớ. */
export function resetBootstrapForTests(): void {
  current = null
  failedAt = 0
}
