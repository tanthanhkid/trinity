'use client'

import { useEffect, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import axios from 'axios'
import { useAuthStore } from '@/store/auth'
import { getAccessToken, getRefreshToken } from '@/lib/token-storage'
import { initGlobalErrorHandlers, logFrontendError } from '@/lib/fe-logger'
import { bootMonitoring, identifyMonitoringUser } from '@/lib/monitoring'
import { forceLogout } from '@/lib/api-client'
import { BuildIdWatcher } from '@/components/build-id-watcher'
import { ChunkErrorWatcher } from '@/components/chunk-error-watcher'
import { TokenRefreshScheduler } from '@/components/token-refresh-scheduler'
import { ServiceWorkerRegister } from '@/components/sw-register'
import { persistKey, restoreQueries, startPersisting } from '@/lib/query-persist'
import { onWipe } from '@/lib/local-cache'

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 600_000,
        // Không retry lỗi 4xx (403/404) — deterministic, retry vô nghĩa và gây trễ UX
        retry: (failureCount, error) => {
          if (axios.isAxiosError(error) && error.response?.status != null) {
            const status = error.response.status
            if (status >= 400 && status < 500) return false
          }
          return failureCount < 1
        },
        refetchOnWindowFocus: false,
        throwOnError: false,
      },
      mutations: {
        retry: 0,
        onError: (error) => logFrontendError(error, { component: 'react-query-mutation' }),
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        logFrontendError(error, {
          component: 'react-query',
          extra: { queryKey: JSON.stringify(query.queryKey) },
        })
        // Force logout on 401 as safety net
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          forceLogout()
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        logFrontendError(error, { component: 'react-query-mutation-cache' })
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          forceLogout()
        }
      },
    }),
  })
}

let browserQueryClient: QueryClient | undefined = undefined

function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    return makeQueryClient()
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient()
  }
  return browserQueryClient
}

/**
 * Cache dữ liệu trên máy: nạp kết quả query lần trước (IndexedDB, khoá theo người dùng + công ty) ngay sau khi biết ai
 * đang đăng nhập, rồi ghi tiếp khi query thành công. Đổi/đăng xuất người dùng ⇒ xoá cache trong bộ nhớ.
 */
function QueryPersistence({ client }: { client: QueryClient }) {
  const hydrated = useAuthStore((s: { _hasHydrated: boolean }) => s._hasHydrated)
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const companyId = useAuthStore((s) => s.company?.id ?? null)
  // Token được đặt lại (cùng người dùng, sau lượt xoá) ⇒ chạy lại effect để bật ghi cache.
  const hasToken = useAuthStore((s) => !!s.accessToken)
  // Tăng khi có tín hiệu xoá (tab này hoặc tab khác) ⇒ dựng lại phiên cache nếu vẫn còn phiên đăng nhập.
  const [epoch, setEpoch] = useState(0)
  const prevKey = useRef<string | null>(null)
  useEffect(() => onWipe(() => {
    client.clear()
    setEpoch((n) => n + 1)
  }), [client])
  useEffect(() => {
    if (!hydrated) return
    const key = userId == null ? null : persistKey({ userId, companyId })
    // Đổi danh tính (A→B, đổi công ty, đăng xuất): xoá dữ liệu trong bộ nhớ TRƯỚC khi nạp/ghi cho khoá mới.
    if (prevKey.current !== key) {
      if (prevKey.current !== null || key === null) client.clear()
      prevKey.current = key
    }
    if (userId == null || !getAccessToken()) return
    let cancelled = false
    let stop: (() => void) | undefined
    const id = { userId, companyId }
    void restoreQueries(client, id, () => cancelled).then(() => {
      if (!cancelled) stop = startPersisting(client, id)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [client, hydrated, userId, companyId, epoch, hasToken])
  return null
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient())
  const hasHydrated = useAuthStore((s: { _hasHydrated: boolean }) => s._hasHydrated)

  // Init global frontend error handlers → send to /api/fe-logging → ELK
  useEffect(() => { initGlobalErrorHandlers() }, [])

  // Giám sát (Sentry/PostHog): tắt mặc định, máy chủ trả config null thì không nạp gì. Đăng nhập sau thì gắn mã băm.
  useEffect(() => {
    void bootMonitoring()
    return useAuthStore.subscribe((s, prev) => {
      if (s.accessToken && !prev.accessToken) void identifyMonitoringUser()
    })
  }, [])

  // Sync tokens from localStorage into Zustand store if store is empty after hydration
  // This handles the case where tokens exist in localStorage (set by api-client refresh)
  // but the Zustand persisted state was cleared or out of sync
  useEffect(() => {
    if (!hasHydrated) return
    const storeToken = useAuthStore.getState().accessToken
    if (!storeToken) {
      const lsToken = getAccessToken()
      const lsRefresh = getRefreshToken()
      if (lsToken && lsRefresh) {
        // Tokens exist in localStorage but not in store - restore them
        // The user object will be fetched by useAuth() hook via getMe()
        useAuthStore.setState({
          accessToken: lsToken,
          refreshToken: lsRefresh,
        })
      }
    }
  }, [hasHydrated])

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors position="top-right" />
      <BuildIdWatcher />
      <ChunkErrorWatcher />
      <TokenRefreshScheduler />
      <QueryPersistence client={queryClient} />
      <ServiceWorkerRegister />
    </QueryClientProvider>
  )
}
