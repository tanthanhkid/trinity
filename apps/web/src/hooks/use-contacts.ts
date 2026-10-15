"use client"

import { useQuery, keepPreviousData } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

/**
 * Danh bạ v3 — page-number pagination + apply-on-submit filter.
 *  - Mọi filter chỉ effect khi user click "Tìm kiếm" (không debounce, không spam 429).
 *  - useQuery thay vì useInfiniteQuery — backend trả `meta.total` + `meta.pages`.
 */
export interface ContactFilters {
  stageId?: string
  contactStatusId?: string
  sourceId?: string
  teamId?: string
  assignedTo?: string
  /** Filter theo dự án (project_id). */
  projectId?: string
  /** Nhãn điểm lead: hot | warm | cold | unscored. */
  leadLabel?: string
  search?: string
  sortBy?: string
  sortOrder?: string
  createdFrom?: string
  createdTo?: string
}

export interface SettingOptionLite {
  id: number
  value: string
  label: string
}

export interface ContactDealLite {
  id: number
  title: string
  status: "open" | "won" | "lost"
  creator_name: string | null
  creator_email: string | null
}

export interface ContactCreatorLite {
  id: number
  full_name: string | null
  role: string | null
}

export interface Contact {
  id: string
  full_name: string
  phone: string
  /** URL avatar khách từ Zalo CDN — có khi khách đã nhắn tin qua Zalo OA. */
  avatar_url?: string | null
  source: SettingOptionLite | null
  /** true khi nguồn bị khoá (khách tạo từ kênh tự động) — UI disable field Nguồn. */
  source_locked?: boolean
  stage_option: SettingOptionLite | null
  contact_status: SettingOptionLite | null
  stage: string
  stage_source: "stage" | "default"
  /** Điểm lead 0–100; null = chưa chấm. */
  lead_score?: number | null
  lead_label?: "hot" | "warm" | "cold" | null
  assigned_to: string
  assignee_name: string
  assignee_email: string | null
  team_id: string
  team_name: string
  created_at: string
  /** Thương vụ mới nhất gắn với contact (người tạo thương vụ). */
  latest_deal: ContactDealLite | null
  /** Người tạo danh bạ — có khi được tạo bởi marketing. */
  creator: ContactCreatorLite | null
}

interface ContactsPage {
  data: Contact[]
  meta: {
    /** Có khi backend chạy page mode. */
    total?: number
    page?: number
    pages?: number
    limit?: number
    /** Có khi backend chạy cursor mode (legacy). */
    next_cursor?: string | null
  }
}

export const CONTACTS_PAGE_SIZE = 50

/**
 * Params filter DÙNG CHUNG giữa `GET /contacts` (list, qua `buildQueryParams`
 * bên dưới) và `GET /contacts/export` (export ÁP filter UI
 * đang chọn). KHÔNG
 * gồm `page`/`limit`/`sort_by`/`sort_order` — export luôn tự sắp xếp trình
 * bày riêng (Phòng ban → Team → NV phụ trách → Khách hàng), không theo sort
 * đang chọn trên bảng list.
 */
export function buildContactFilterParams(
  filters: ContactFilters,
): Record<string, string> {
  const params: Record<string, string> = {}
  if (filters.stageId && filters.stageId !== "all") {
    params.stage_id = filters.stageId
  }
  if (filters.contactStatusId && filters.contactStatusId !== "all") {
    params.contact_status_id = filters.contactStatusId
  }
  if (filters.sourceId && filters.sourceId !== "all") {
    params.source_id = filters.sourceId
  }
  if (filters.teamId && filters.teamId !== "all") params.team_id = filters.teamId
  if (filters.assignedTo) params.assigned_to = filters.assignedTo
  if (filters.projectId && filters.projectId !== "all") params.project_id = filters.projectId
  if (filters.leadLabel && filters.leadLabel !== "all") params.lead_label = filters.leadLabel
  const search = filters.search?.trim()
  if (search) params.search = search
  if (filters.createdFrom) params.created_from = filters.createdFrom
  if (filters.createdTo) params.created_to = filters.createdTo
  return params
}

function buildQueryParams(
  page: number,
  filters: ContactFilters,
): Record<string, string> {
  const params: Record<string, string> = {
    page: String(page),
    limit: String(CONTACTS_PAGE_SIZE),
    ...buildContactFilterParams(filters),
  }
  if (filters.sortBy) params.sort_by = filters.sortBy
  if (filters.sortOrder) params.sort_order = filters.sortOrder
  return params
}

interface UseContactsArgs {
  filters: ContactFilters
  page: number
  enabled?: boolean
}

export function useContacts({ filters, page, enabled = true }: UseContactsArgs) {
  const query = useQuery<ContactsPage, Error>({
    queryKey: ["contacts", "page", page, filters],
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = buildQueryParams(page, filters)
      const res = await apiClient.get<ContactsPage>("/contacts", { params })
      return res.data
    },
  })

  const contacts = query.data?.data ?? []
  const total = query.data?.meta.total ?? 0
  const pages = query.data?.meta.pages ?? 1

  return {
    contacts,
    total,
    page: query.data?.meta.page ?? page,
    pages,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  }
}
