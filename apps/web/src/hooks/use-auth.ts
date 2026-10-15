'use client'

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../store/auth'
import { getMe } from '../lib/auth-api'
import { getAccessToken } from '../lib/token-storage'
import { forceLogout } from '../lib/api-client'
import type { AuthMe, User } from '../types/auth'

interface UseAuthReturn {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
}

export function useAuth(): UseAuthReturn {
  const { user, setAuth, clearAuth, accessToken, _hasHydrated } = useAuthStore()

  // Check both Zustand store AND localStorage for token availability
  // This handles the gap between hydration and store sync
  const hasToken = !!accessToken || (typeof window !== 'undefined' && !!getAccessToken())

  const { data, isLoading, error } = useQuery<AuthMe>({
    queryKey: ['auth', 'me'],
    queryFn: getMe,
    enabled: _hasHydrated && hasToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (data && hasToken) {
      const token = accessToken ?? getAccessToken() ?? ''
      const refresh = useAuthStore.getState().refreshToken ?? ''
      setAuth(data, {
        accessToken: token,
        refreshToken: refresh,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hasToken, accessToken, setAuth])

  useEffect(() => {
    if (error && _hasHydrated) {
      // Chỉ đăng xuất khi máy chủ từ chối phiên (401/403); lỗi mạng/5xx thoáng qua không được đá người dùng ra.
      const status = (error as { response?: { status?: number } }).response?.status
      if (status === 401 || status === 403) {
        clearAuth()
        forceLogout()
      }
    }
  }, [error, _hasHydrated, clearAuth])

  const resolvedUser = data?.user ?? user

  return {
    user: resolvedUser ?? null,
    isLoading: !_hasHydrated || isLoading,
    isAuthenticated: !!resolvedUser,
  }
}
