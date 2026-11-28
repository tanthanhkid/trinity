import { dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/react-query'
import { idbDelete, idbGet, idbSet, onWipe } from './local-cache'
import { getAccessToken } from './token-storage'

/**
 * Cache dữ liệu API trên máy (vòng 3): kết quả query lưu vào IndexedDB, lần mở sau vẽ NGAY dữ liệu lần trước rồi
 * React Query refetch ngầm (dữ liệu cũ hơn `staleTime` ⇒ coi là stale ⇒ refetch khi component mount).
 *
 * - Khoá theo người dùng + công ty: `rq:<companyId>:<userId>`. Đổi người ⇒ không bao giờ đọc nhầm bản của người khác.
 * - Chỉ lưu dữ liệu query (không token). Loại các query có khoá chứa từ nhạy cảm (`DENY`) và query quá lớn.
 * - Hết hạn 24 giờ; `BUSTER` đổi ⇒ bỏ cache (đổi hình dạng dữ liệu giữa hai bản phát hành).
 * - Xoá khi đăng xuất: `wipeLocalCaches()` (local-cache.ts) gọi từ `clearTokens()`.
 */

export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** Tăng khi hình dạng dữ liệu cache đổi không tương thích. */
export const PERSIST_BUSTER = 'v1'
const THROTTLE_MS = 1500
const MAX_QUERY_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const enc = new TextEncoder()
const DENY = /(api[-_]?key|secret|token|password|oauth|credential|mcp|webhook|inbound-source|2fa|otp)/i

function hasToken(): boolean {
  try {
    return !!getAccessToken()
  } catch {
    return false
  }
}

export interface PersistIdentity {
  userId: number | string
  companyId: number | string | null | undefined
}

export function persistKey(id: PersistIdentity): string {
  return `rq:${id.companyId ?? 0}:${id.userId}`
}

/** Query nào được lưu: thành công, có dữ liệu, khoá không thuộc nhóm nhạy cảm. Xuất để test. */
export function shouldPersistQuery(query: Pick<Query, 'queryKey' | 'state'>): boolean {
  if (query.state.status !== 'success' || query.state.data === undefined) return false
  let k: string
  try {
    k = JSON.stringify(query.queryKey)
  } catch {
    return false
  }
  return !DENY.test(k)
}

interface Persisted {
  buster: string
  savedAt: number
  state: ReturnType<typeof dehydrate>
}

/**
 * Nạp cache của người dùng vào `client`. `true` khi có hydrate. Không ném lỗi.
 * `isCancelled`: effect đã dọn (đăng xuất / đổi người giữa chừng) ⇒ bỏ hydrate, không đổ dữ liệu vào client.
 */
export async function restoreQueries(
  client: QueryClient,
  id: PersistIdentity,
  isCancelled: () => boolean = () => false,
): Promise<boolean> {
  try {
    const saved = await idbGet<Persisted>(persistKey(id))
    if (isCancelled()) return false
    if (!saved || saved.buster !== PERSIST_BUSTER) return false
    if (Date.now() - saved.savedAt > PERSIST_MAX_AGE_MS) {
      void idbDelete(persistKey(id))
      return false
    }
    hydrate(client, saved.state)
    return true
  } catch {
    return false
  }
}

/**
 * Bắt đầu ghi cache (throttle, ghi lượt cuối). Trả hàm dừng. Cache kích thước hợp lý: bỏ query > 256 KB và cắt
 * khi tổng > 4 MB (giữ các query mới cập nhật nhất).
 */
export function startPersisting(client: QueryClient, id: PersistIdentity): () => void {
  const key = persistKey(id)
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const write = () => {
    timer = null
    if (stopped) return
    // Phiên đã kết thúc (đăng xuất, hoặc tab khác đăng xuất): không ghi nữa dù lượt ghi này đã hẹn từ trước.
    if (!hasToken()) return
    try {
      const state = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery })
      // Sắp theo mới nhất, bỏ query quá lớn, cắt khi vượt tổng.
      const sized = state.queries
        .map((q) => ({ q, n: enc.encode(JSON.stringify(q.state.data)).length }))
        .filter((x) => x.n <= MAX_QUERY_BYTES)
        .sort((a, b) => (b.q.state.dataUpdatedAt ?? 0) - (a.q.state.dataUpdatedAt ?? 0))
      let total = 0
      const kept = []
      for (const x of sized) {
        if (total + x.n > MAX_TOTAL_BYTES) continue
        total += x.n
        kept.push(x.q)
      }
      const payload: Persisted = { buster: PERSIST_BUSTER, savedAt: Date.now(), state: { ...state, queries: kept } }
      void idbSet(key, payload)
    } catch {
      /* cache chỉ là tối ưu */
    }
  }
  const schedule = () => {
    if (stopped || timer) return
    timer = setTimeout(write, THROTTLE_MS)
  }

  const unsubscribe = client.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'success') schedule()
  })
  // Tín hiệu xoá (tab này hoặc tab khác): dừng bản ghi này. Bật lại do người gọi dựng `startPersisting` mới
  // khi có phiên (xem `QueryPersistence` ở providers.tsx).
  const offWipe = onWipe(() => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  })
  const flush = () => {
    if (document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer)
      write()
    }
  }
  document.addEventListener('visibilitychange', flush)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    unsubscribe()
    document.removeEventListener('visibilitychange', flush)
    offWipe()
  }
}
