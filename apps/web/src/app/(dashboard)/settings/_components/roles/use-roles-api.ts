'use client'

import { errorMessage } from "@/lib/error-messages"
import axios from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Grants, Permission, Scope } from '@trinity/rbac'
import apiClient from '@/lib/api-client'

/** Khớp BE `GET /roles` — FE Kanban cũng đọc đúng shape này. */
export interface RoleSummary {
  id: number
  name: string
  description: string | null
  is_system: boolean
  member_count: number
}

export interface RoleDetail extends RoleSummary {
  grants: Grants
}

export interface CatalogPermission {
  key: Permission
  group: string
  label: string
  scoped: boolean
  sensitive?: boolean
}

export interface RbacCatalog {
  groups: string[]
  permissions: CatalogPermission[]
  scopes: { value: Scope; label: string }[]
}

export interface RoleMember {
  id: number
  full_name: string
  /** null = người ngoài phạm vi `users.view` của người xem (BE che email). */
  email: string | null
  status: string
}

export interface AuditRow {
  id: number
  actor_id: number
  actor_name: string
  action: string
  target_type: 'role' | 'user'
  target_id: number
  target_name: string | null
  before: unknown
  after: unknown
  created_at: string
}

export interface AuditPage {
  data: AuditRow[]
  total: number
  page: number
  limit: number
}

/** Body `grants` gửi BE: scoped → scope; không scoped → null (lỗi BE hiện nguyên văn). */
export type GrantsPayload = Record<string, Scope | null>

/** đọc MESSAGE THẬT từ response BE (string | string[]), không hardcode câu tĩnh. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return errorMessage(err, fallback)
}

export function grantsToPayload(grants: Grants): GrantsPayload {
  const out: GrantsPayload = {}
  for (const [k, v] of Object.entries(grants)) out[k] = v === true ? null : (v as Scope)
  return out
}

export const ROLES_KEY = ['rbac', 'roles'] as const

export function useRoleList(enabled = true) {
  return useQuery({
    queryKey: ROLES_KEY,
    enabled,
    queryFn: async () => (await apiClient.get<RoleSummary[]>('/roles')).data,
  })
}

export function useRoleDetail(id: number | null) {
  return useQuery({
    queryKey: [...ROLES_KEY, id],
    enabled: id !== null,
    queryFn: async () => (await apiClient.get<RoleDetail>(`/roles/${id}`)).data,
  })
}

export function useRbacCatalog() {
  return useQuery({
    queryKey: ['rbac', 'catalog'],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => (await apiClient.get<RbacCatalog>('/rbac/catalog')).data,
  })
}

export function useRoleMembers(id: number) {
  return useQuery({
    queryKey: ['rbac', 'members', id],
    queryFn: async () => (await apiClient.get<RoleMember[]>(`/roles/${id}/members`)).data,
  })
}

export function useRoleAudit(id: number, page: number) {
  return useQuery({
    queryKey: ['rbac', 'audit', id, page],
    queryFn: async () =>
      (await apiClient.get<AuditPage>('/rbac/audit', { params: { targetType: 'role', targetId: id, page, limit: 20 } }))
        .data,
  })
}

/** Mọi mutation vai trò/gán người đổi cả danh sách vai trò, người giữ, nhật ký, danh sách user. */
export function useRbacInvalidate() {
  const qc = useQueryClient()
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['rbac'] }), qc.invalidateQueries({ queryKey: ['users'] })])
}

export function useCreateRole() {
  const invalidate = useRbacInvalidate()
  return useMutation({
    mutationFn: async (b: { name: string; description?: string; grants: GrantsPayload }) =>
      (await apiClient.post<RoleDetail>('/roles', b)).data,
    onSuccess: invalidate,
  })
}

export function useCloneRole() {
  const invalidate = useRbacInvalidate()
  return useMutation({
    mutationFn: async (id: number) => (await apiClient.post<RoleDetail>(`/roles/${id}/clone`)).data,
    onSuccess: invalidate,
  })
}

export function useUpdateRole(id: number) {
  const invalidate = useRbacInvalidate()
  return useMutation({
    mutationFn: async (b: { name?: string; description?: string | null }) =>
      (await apiClient.patch<RoleDetail>(`/roles/${id}`, b)).data,
    onSuccess: invalidate,
  })
}

export function useSaveGrants(id: number) {
  const invalidate = useRbacInvalidate()
  return useMutation({
    mutationFn: async (grants: Grants) =>
      (await apiClient.put<RoleDetail>(`/roles/${id}/grants`, { grants: grantsToPayload(grants) })).data,
    onSuccess: invalidate,
  })
}

export function useDeleteRole() {
  const invalidate = useRbacInvalidate()
  return useMutation({
    mutationFn: async (id: number) => (await apiClient.delete(`/roles/${id}`)).data,
    onSuccess: invalidate,
  })
}

/** `PUT /users/:id/roles` — THAY toàn bộ vai trò của 1 người. */
export function useSetUserRoles() {
  const invalidate = useRbacInvalidate()
  return useMutation({
    mutationFn: async (v: { userId: number; roleIds: number[] }) =>
      (await apiClient.put(`/users/${v.userId}/roles`, { roleIds: v.roleIds })).data,
    onSuccess: invalidate,
  })
}
