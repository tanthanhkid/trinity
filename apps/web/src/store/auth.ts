'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Grants } from '@trinity/rbac'
import type { AuthMe, AuthTokens, Role, User } from '../types/auth'

const EMPTY_GRANTS: Grants = {}

interface AuthState {
  user: User | null
  roles: Role[]
  /** RBAC quyền + phạm vi — nguồn DUY NHẤT cho `usePermissions()`. */
  permissions: Grants
  isAdmin: boolean
  accessToken: string | null
  refreshToken: string | null
  _hasHydrated: boolean
  setAuth: (auth: AuthMe, tokens: AuthTokens) => void
  clearAuth: () => void
  setHasHydrated: (value: boolean) => void
}

const AUTH_PERSIST_KEY = 'trinity-auth'

const authPersistStorage = createJSONStorage(() => ({
  getItem: (name: string): string | null => {
    try {
      return window.localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      window.localStorage.setItem(name, value)
    } catch {
      /* private mode / quota — state trong memory vẫn đúng */
    }
  },
  removeItem: (name: string): void => {
    try {
      window.localStorage.removeItem(name)
    } catch {
      /* ignore */
    }
  },
}))

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      roles: [],
      permissions: EMPTY_GRANTS,
      isAdmin: false,
      accessToken: null,
      refreshToken: null,
      _hasHydrated: false,
      setAuth: (auth: AuthMe, tokens: AuthTokens) =>
        set({
          user: auth.user,
          roles: auth.roles,
          permissions: auth.permissions,
          isAdmin: auth.isAdmin,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        }),
      clearAuth: () => {
        set({
          user: null,
          roles: [],
          permissions: EMPTY_GRANTS,
          isAdmin: false,
          accessToken: null,
          refreshToken: null,
        })
        // Đảm bảo localStorage (persist) cũng bị xoá sạch để phiên cũ không
        // rehydrate lại trên tab khác / lần refresh kế tiếp.
        if (typeof window !== 'undefined') {
          try {
            useAuthStore.persist.clearStorage()
          } catch {
            window.localStorage.removeItem(AUTH_PERSIST_KEY)
          }
        }
      },
      setHasHydrated: (value: boolean) => set({ _hasHydrated: value }),
    }),
    {
      name: AUTH_PERSIST_KEY,
      storage: authPersistStorage,
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true)
      },
    },
  ),
)
