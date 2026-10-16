'use client'

import { useEffect, useState } from 'react'
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
    </QueryClientProvider>
  )
}
