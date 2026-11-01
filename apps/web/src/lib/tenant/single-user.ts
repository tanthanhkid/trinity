'use client'

import { useAuthStore } from '@/store/auth'

/**
 * Trinity SaaS: one sign-up = one company = one user (its owner). For such a company the screens about other
 * people — staff management, users, roles, departments, teams, office Wi-Fi login check — make no sense and are
 * hidden. The server refuses to create a second user anyway.
 */
export const SINGLE_USER_HIDDEN_NAV_KEYS: ReadonlySet<string> = new Set(['management'])
export const SINGLE_USER_HIDDEN_SETTINGS_TABS: ReadonlySet<string> = new Set([
  'users',
  'roles',
  'departments',
  'teams',
  'login-wifi-check',
])

export function useIsSingleUserCompany(): boolean {
  return useAuthStore((s) => s.company?.single_user === true)
}
