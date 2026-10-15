"use client"

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { nDaysAgoVn, todayVn } from "@/lib/format"
import type { ContactFilters } from "@/hooks/use-contacts"

/** Khớp `SortField` của `contacts-constants.ts` — allowlist tránh URL bị sửa tay. */
const SORT_FIELDS = ["created_at", "full_name", "lead_score"]

function str(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key)
  return v && v.length > 0 ? v : undefined
}

function parseSortBy(params: URLSearchParams): ContactFilters["sortBy"] {
  const v = params.get("sort_by")
  return v && SORT_FIELDS.includes(v) ? v : undefined
}

function parseSortOrder(params: URLSearchParams): ContactFilters["sortOrder"] {
  const v = params.get("sort_order")
  return v === "asc" || v === "desc" ? v : undefined
}

function parsePage(params: URLSearchParams): number {
  const raw = Number(params.get("page"))
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
}

/**
 * Đọc filters + page từ URLSearchParams — dùng cả lúc mount lẫn khi URL đổi
 * qua back/forward trình duyệt.
 *
 * `params.toString() === ""` = trang `/contacts` KHÔNG có filter nào trong
 * URL (lần đầu vào màn, gõ thẳng URL trần, hoặc mở tab mới) → giữ NGUYÊN
 * default cũ: 7 ngày trước → hôm nay. Đây là default DUY NHẤT
 * cho state "URL trống"; "Đặt lại" (xem `contacts/page.tsx` `handleReset`)
 * commit tường minh {} (không dates) lên URL nên KHÔNG rơi vào nhánh này
 * trong cùng phiên duyệt — chỉ khi rời hẳn trang rồi quay lại bằng URL
 * trần (không qua lịch sử) mới thấy lại default 7 ngày, đây là đánh đổi
 * cố ý (phạm vi là "back-nav không mất filter", không phải đổi
 * default ban đầu của màn).
 *
 * Khi người dùng cố ý commit KHÔNG filter nào (Đặt lại / gỡ chip cuối, không có sort) thì URL sẽ trần
 * và default 7 ngày bị áp lại ngay — nên `commitFilters` ghi dấu `reset=1` để URL không trống
 * (tham số này không phải filter, `parseContactFiltersFromParams` bỏ qua).
 */
export function parseContactFiltersFromParams(
  params: URLSearchParams,
): { filters: ContactFilters; page: number } {
  if (params.toString() === "") {
    return {
      filters: { createdFrom: nDaysAgoVn(7), createdTo: todayVn() },
      page: 1,
    }
  }
  return {
    filters: {
      stageId: str(params, "stage_id"),
      contactStatusId: str(params, "contact_status_id"),
      sourceId: str(params, "source_id"),
      teamId: str(params, "team_id"),
      assignedTo: str(params, "assigned_to"),
      projectId: str(params, "project_id"),
      leadLabel: str(params, "lead_label"),
      search: str(params, "search"),
      sortBy: parseSortBy(params),
      sortOrder: parseSortOrder(params),
      createdFrom: str(params, "created_from"),
      createdTo: str(params, "created_to"),
    },
    page: parsePage(params),
  }
}

function applyStr(p: URLSearchParams, key: string, v: string | undefined): void {
  if (v === undefined || v === "") p.delete(key)
  else p.set(key, v)
}

/** Ghi filters + page vào URLSearchParams MỚI (KHÔNG mutate tham số vào). */
export function buildContactUrlParams(
  filters: ContactFilters,
  page: number,
): URLSearchParams {
  const p = new URLSearchParams()
  applyStr(p, "stage_id", filters.stageId)
  applyStr(p, "contact_status_id", filters.contactStatusId)
  applyStr(p, "source_id", filters.sourceId)
  applyStr(p, "team_id", filters.teamId)
  applyStr(p, "assigned_to", filters.assignedTo)
  applyStr(p, "project_id", filters.projectId)
  applyStr(p, "lead_label", filters.leadLabel)
  applyStr(p, "search", filters.search)
  applyStr(p, "sort_by", filters.sortBy)
  applyStr(p, "sort_order", filters.sortOrder)
  applyStr(p, "created_from", filters.createdFrom)
  applyStr(p, "created_to", filters.createdTo)
  if (page > 1) p.set("page", String(page))
  else p.delete("page")
  return p
}

/** So sánh 2 `ContactFilters` theo TOÀN BỘ field đã biết — dùng để bail-out setState. */
export function areContactFiltersEqual(a: ContactFilters, b: ContactFilters): boolean {
  const keys: (keyof ContactFilters)[] = [
    "stageId", "contactStatusId", "sourceId", "teamId",
    "assignedTo", "projectId", "leadLabel", "search", "sortBy", "sortOrder", "createdFrom", "createdTo",
  ]
  return keys.every((k) => (a[k] ?? "") === (b[k] ?? ""))
}

export interface UseContactsUrlFiltersReturn {
  /** Filter ĐANG ÁP DỤNG — nguồn DUY NHẤT gửi API, derive từ URL. */
  appliedFilters: ContactFilters
  /** Trang hiện tại — derive từ URL. */
  page: number
  /**
   * Ghi filters + page mới vào URL (`router.replace`, KHÔNG thêm history
   * entry mới — giữ nút Back trình duyệt đưa thẳng ra ngoài trang thay vì
   * lùi qua từng lượt filter). Mọi hành động apply filter của `/contacts`
   * (Tìm kiếm / Đặt lại / đổi sort / đổi trang) đi qua đây.
   */
  commitFilters: (filters: ContactFilters, page: number) => void
}

/**
 * Nguồn chân lý filter Danh bạ (`/contacts`) là URL query params — KHÔNG
 * còn `useState` cục bộ cho `appliedFilters`/`page`. Fix: mở 1
 * liên hệ rồi quay lại trước đây MẤT SẠCH filter vì component re-init về
 * default (state cục bộ không sống sót qua back-navigation). Giờ URL giữ
 * state nên back/forward + mở tab mới cùng URL đều khôi phục đúng.
 *
 * KHÔNG đổi thiết kế "apply-on-submit" (chống spam API trên
 * bảng lớn — xem JSDoc `contacts/page.tsx`) — CHỈ filter ĐÃ APPLY mới ra
 * URL; state nháp (`pendingFilters`/`searchInput` ở `page.tsx`) vẫn là
 * `useState` cục bộ, không đụng URL cho tới khi bấm "Tìm kiếm".
 */
export function useContactsUrlFilters(): UseContactsUrlFiltersReturn {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const { filters: appliedFilters, page } = useMemo(
    () => parseContactFiltersFromParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  )

  const commitFilters = useCallback(
    (filters: ContactFilters, nextPage: number) => {
      const params = buildContactUrlParams(filters, nextPage)
      const qs = params.toString() || "reset=1"
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [router, pathname],
  )

  return { appliedFilters, page, commitFilters }
}
