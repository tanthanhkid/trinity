"use client"

import { Suspense, useState, useCallback, useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import {
  Plus, Loader2, Trash2, MoreHorizontal, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, FileSpreadsheet, Send,
  ArrowDownUp,
} from "lucide-react"
import {
  useContacts,
  CONTACTS_PAGE_SIZE,
  type ContactFilters,
} from "@/hooks/use-contacts"
import { useContactsExport } from "@/hooks/use-contacts-export"
import { useContactsUrlFilters, areContactFiltersEqual } from "@/hooks/use-contacts-filters"
import { useAuth } from "@/hooks/use-auth"
import { useOrgFeature } from "@/hooks/use-org-features"
import { toast } from "sonner"
import { deferWithUndo } from "@/lib/undo"
import { formatCount } from "@/lib/format"
import { ContactRow, ContactCard } from "./_components/contact-row"
import { ContactsFilters } from "./_components/contacts-filters"
import { ContactsTableHeader } from "./_components/contacts-table-header"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { contactSignals, latestAiActionByContact } from "./_components/contact-signals"
import { useRecentAiActions } from "@/app/(dashboard)/dashboard/_components/use-home-data"
import { todayVn } from "@/lib/format"
import { BulkTransferContactsDialog } from "./_components/bulk-transfer-contacts-dialog"
import {
  BULK_DELETE_MAX,
  BULK_TRANSFER_MAX,
  type SortField,
} from "./_components/contacts-constants"
import apiClient, { sendKeepalive } from "@/lib/api-client"
import { Can, Forbidden, usePermissions } from "@/lib/rbac"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"

/** Kết quả thất bại khi xoá contact — dùng trong handleBulkDelete. */
interface ContactDeleteFailure {
  id: string
  reason: string
}

/**
 * Gửi lệnh xoá lên máy chủ — gọi SAU khi hết 5 giây hoàn tác (xem `deferWithUndo`).
 * Đặt ngoài component: người dùng chuyển trang trong lúc chờ thì lệnh vẫn chạy.
 */
async function commitContactDelete(ids: string[], queryClient: QueryClient) {
  try {
    const results = await Promise.allSettled(
      ids.map((id) => apiClient.delete(`/contacts/${id}`)),
    )

    const failures: ContactDeleteFailure[] = []
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        const id = ids[idx]
        const raw = (r.reason as { response?: { data?: { message?: string | string[] } } })
          ?.response?.data?.message
        const reason = Array.isArray(raw)
          ? raw.join(", ")
          : typeof raw === "string" && raw.length > 0
            ? raw
            : r.reason instanceof Error
              ? r.reason.message
              : "Không xoá được"
        failures.push({ id, reason })
      }
    })

    if (failures.length > 0) {
      // Gom lý do: nếu ≤3 lần thì show inline, nếu nhiều hơn gom theo lý do
      const reasonGroups: Record<string, string[]> = {}
      for (const f of failures) {
        reasonGroups[f.reason] = reasonGroups[f.reason] ?? []
        reasonGroups[f.reason].push(f.id)
      }
      const lines = Object.entries(reasonGroups).map(
        ([reason, ids]) =>
          `• ${ids.length} khách hàng (ID: ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? "..." : ""}): ${reason}`,
      )
      toast.error(
        `Có ${failures.length} khách hàng xoá thất bại:\n${lines.join("\n")}`,
        { duration: 8000 },
      )
      console.error("[contacts-bulk-delete] failures", failures)
    }
  } finally {
    // Thành công hay lỗi đều tải lại: khách xoá hỏng phải hiện lại trong danh sách.
    queryClient.invalidateQueries({ queryKey: ["contacts"] })
  }
}

/**
 * Danh bạ v3 — apply-on-submit + page-number pagination.
 *
 * **Vấn đề trước đây:** debounce search 400ms + filter instant → mỗi keystroke và
 * mỗi lần đổi dropdown đều bắn API → spam → 429 trên bảng lớn.
 *
 * **Giải pháp:**
 *  1. Tách `pendingFilters` (state UI đang gõ) vs `appliedFilters` (state gửi API).
 *     Backend chỉ refetch khi `appliedFilters` đổi → click "Tìm kiếm" mới apply.
 *  2. Sort header click vẫn apply ngay (UX quen thuộc, không gây spam vì 1 click).
 *  3. Pagination page-number thay infinite scroll (backend trả `meta.total` + cache 60s).
 *
 * **Giới hạn trang:** OFFSET >2K trên bảng contacts lớn kéo P95 vượt 1s → backend
 * chặn ở `MAX_PAGE_OFFSET=2_000` (40 trang ở `limit=50`). FE cap `pages` lại
 * và toast nhắc thu hẹp bộ lọc khi user thử nhảy quá.
 *
 * **RBAC:** thiếu quyền `contacts.view` → `<Forbidden />` (xem `ContactsPage`
 * cuối file); nút Thêm/Xuất/Chuyển/Xoá theo `contacts.create|export|transfer|delete`.
 */
/**
 * Số trang tối đa hiển thị FE — khớp với BE `MAX_PAGE_OFFSET / limit = 2000/50`.
 * Nếu BE đổi limit hoặc MAX_PAGE_OFFSET, cập nhật cùng nhau (đã document trong
 * `services/crm/src/contacts/contacts.service.ts`).
 */
const MAX_VISIBLE_PAGES = 40

/**
 * Danh bạ v4 — filter ĐÃ ÁP DỤNG + trang hiện tại nay sống
 * trong URL query params (`useContactsUrlFilters`), KHÔNG còn `useState`
 * cục bộ. Trước đây mở 1 liên hệ rồi quay lại (back trình duyệt / nút
 * "Quay lại") làm MẤT SẠCH bộ lọc vì component re-init state về default —
 * URL sống sót qua back-navigation nên khôi phục đúng. `useSearchParams()`
 * bắt buộc bọc `<Suspense>` — xem default export cuối file.
 */
function ContactsPageContent() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { can, scopeOf } = usePermissions()
  const { appliedFilters, page, commitFilters } = useContactsUrlFilters()

  // Dropdown lọc người (Phụ trách/Người tạo) chỉ có nghĩa khi phạm vi xem
  // rộng hơn "chỉ của mình" (BE `/contacts/assignable-users` cắt theo phạm vi).
  const viewScope = scopeOf("contacts.view")
  const canFilterAssignee = viewScope !== null && viewScope !== "own"
  // Xoá hàng loạt (`contacts.delete`) + chuyển nhiều liên hệ
  // (`contacts.transfer`) dùng CHUNG selectedIds/checkbox. BE kiểm phạm vi từng
  // dòng; FE chỉ ẩn/hiện nút theo quyền.
  const canBulkDelete = can("contacts.delete")
  const canBulkTransfer = can("contacts.transfer")
  const canSelectRows = canBulkDelete || canBulkTransfer
  // Điểm lead: cờ org `lead_scoring` tắt → bỏ cột + bộ lọc.
  const scoringOn = useOrgFeature("lead_scoring")
  // Xuất Excel: quyền RIÊNG `contacts.export` — BE (`GET
  // /contacts/export`) tự quyết cột nào được xuất theo `contacts.phone_full`.
  const canExport = can("contacts.export")
  const { exportContacts, isExporting } = useContactsExport()

  // Pending = state user đang chỉnh (draft, KHÔNG ra URL cho tới khi apply);
  // Applied = filter thật sự gửi API, derive từ URL (xem `useContactsUrlFilters`).
  const [pendingFilters, setPendingFilters] = useState<ContactFilters>(() => appliedFilters)
  const [searchInput, setSearchInput] = useState<string>(() => appliedFilters.search ?? "")

  // Đồng bộ draft khi `appliedFilters` (URL) đổi — xảy ra khi CHÍNH mình vừa
  // commit (no-op, giá trị đã khớp draft) HOẶC khi URL đổi TỪ NGOÀI (back/
  // forward trình duyệt phục hồi filter cũ) — bail-out
  // tránh set lại khi giá trị không đổi.
  useEffect(() => {
    setPendingFilters((prev) => (areContactFiltersEqual(prev, appliedFilters) ? prev : appliedFilters))
    setSearchInput((prev) => {
      const next = appliedFilters.search ?? ""
      return prev === next ? prev : next
    })
  }, [appliedFilters])

  const {
    contacts,
    total,
    pages,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useContacts({
    filters: appliedFilters,
    page,
  })

  const isDirty = useMemo(() => {
    const pendingSearch = searchInput.trim()
    const appliedSearch = appliedFilters.search ?? ""
    if (pendingSearch !== appliedSearch) return true
    const keys: (keyof ContactFilters)[] = [
      "stageId", "contactStatusId", "sourceId",
      "createdFrom", "createdTo", "assignedTo", "teamId",
      "projectId", "leadLabel",
    ]
    return keys.some((k) => (pendingFilters[k] ?? "") !== (appliedFilters[k] ?? ""))
  }, [pendingFilters, appliedFilters, searchInput])

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkTransferOpen, setBulkTransferOpen] = useState(false)

  const visibleIds = useMemo(() => contacts.map((c) => c.id), [contacts])
  const allSelected =
    canSelectRows &&
    visibleIds.length > 0 &&
    visibleIds.every((id) => selectedIds.includes(id))
  // Thanh hành động hàng loạt (Chuyển cho.../Xoá đã chọn) chỉ nổi lên khi có
  // dòng đã chọn — tách khỏi
  // hàng tiêu đề.
  const hasBulkBar = canSelectRows && selectedIds.length > 0

  const requestBulkTransfer = () => {
    if (selectedIds.length > BULK_TRANSFER_MAX) {
      toast.error(`Chỉ được chuyển tối đa ${BULK_TRANSFER_MAX} khách hàng mỗi lần`)
      return
    }
    setBulkTransferOpen(true)
  }
  const requestBulkDelete = () => {
    if (selectedIds.length > BULK_DELETE_MAX) {
      toast.error(`Chỉ được xoá tối đa ${BULK_DELETE_MAX} khách hàng mỗi lần`)
      return
    }
    setBulkDeleteOpen(true)
  }

  // Danh sách cũ vẫn còn trên màn hình mà tải mới lỗi ⇒ báo bằng toast; danh sách trống thì khung lỗi bên dưới đã nói.
  const staleError = isError && contacts.length > 0
  useEffect(() => {
    if (staleError) toast.error("Không cập nhật được danh sách khách hàng — đang hiện dữ liệu cũ")
  }, [staleError])

  // Đang lọc/tìm ⇒ danh sách trống là "không khớp", không phải "chưa có khách".
  const hasFilters = Object.entries(appliedFilters).some(([k, v]) => k !== "sortBy" && k !== "sortOrder" && v != null && v !== "")

  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value)
  }, [])

  const setPendingFilter = useCallback(
    (key: keyof ContactFilters) => (value: string) => {
      setPendingFilters((f) => ({
        ...f,
        [key]: value === "all" || value === "" ? undefined : value,
      }))
    },
    [],
  )

  const handleApply = useCallback(() => {
    const trimmed = searchInput.trim()
    commitFilters(
      {
        ...pendingFilters,
        // Giữ sort hiện tại của appliedFilters (sort không thuộc filter form).
        sortBy: appliedFilters.sortBy,
        sortOrder: appliedFilters.sortOrder,
        search: trimmed || undefined,
      },
      1,
    )
  }, [pendingFilters, searchInput, appliedFilters.sortBy, appliedFilters.sortOrder, commitFilters])

  const handleReset = useCallback(() => {
    const resetFilters: ContactFilters = {
      sortBy: appliedFilters.sortBy,
      sortOrder: appliedFilters.sortOrder,
    }
    // Cập nhật draft ngay (phản hồi tức thì) — effect đồng bộ ở trên sẽ
    // confirm lại giá trị này khi URL cập nhật xong, không xung đột.
    setPendingFilters(resetFilters)
    setSearchInput("")
    commitFilters(resetFilters, 1)
  }, [appliedFilters.sortBy, appliedFilters.sortOrder, commitFilters])

  /**
   * Gỡ 1 điều kiện từ dải chip — commit NGAY (không chờ bấm "Tìm kiếm").
   *
   * Bấm × trên chip là hành vi "bỏ điều kiện này đi": bắt bấm thêm "Tìm kiếm"
   * mới có tác dụng thì chip vẫn còn trên màn hình sau khi bấm ×, đọc như nút
   * hỏng. Cập nhật CẢ pending (để form khớp) lẫn applied (để danh sách đổi),
   * và về trang 1 vì phạm vi vừa rộng ra.
   *
   * `search` nằm trong chip nhưng KHÔNG thuộc `pendingFilters` (nó là state ô
   * nhập riêng) nên phải xoá `searchInput` tường minh — thiếu dòng đó thì bấm
   * × chỉ bỏ được 1 lượt, lần "Tìm kiếm" kế tiếp lại nạp từ khoá cũ vào.
 */
  const handleRemoveAppliedFilter = useCallback(
    (key: keyof ContactFilters) => {
      if (key === "search") setSearchInput("")
      setPendingFilters((f) => ({ ...f, [key]: undefined }))
      commitFilters({ ...appliedFilters, [key]: undefined }, 1)
    },
    [appliedFilters, commitFilters],
  )

  // Sort vẫn apply ngay (1 click, không gây spam) — đồng thời update applied + reset page.
  const toggleSort = useCallback(
    (field: SortField) => {
      let next: ContactFilters
      if (appliedFilters.sortBy === field) {
        next =
          appliedFilters.sortOrder === "asc"
            ? { ...appliedFilters, sortOrder: "desc" }
            : { ...appliedFilters, sortBy: undefined, sortOrder: undefined }
      } else {
        next = { ...appliedFilters, sortBy: field, sortOrder: "asc" }
      }
      commitFilters(next, 1)
    },
    [appliedFilters, commitFilters],
  )

  const handleRowHover = useCallback(
    (contactId: string) => {
      queryClient.prefetchQuery({
        queryKey: ["contact", contactId],
        queryFn: async () => {
          const res = await apiClient.get(`/contacts/${contactId}`)
          return res.data
        },
        staleTime: 120_000,
      })
    },
    [queryClient],
  )

  const handleNavigate = useCallback(
    (id: string) => router.push(`/contacts/${id}`),
    [router],
  )

  // Khi đổi trang/đổi filter → contacts mới → loại bỏ selectedIds không còn visible.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.length === 0) return prev
      const visibleSet = new Set(visibleIds)
      const next = prev.filter((id) => visibleSet.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [visibleIds])

  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) return prev.includes(id) ? prev : [...prev, id]
      return prev.filter((item) => item !== id)
    })
  }, [])

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      if (!canSelectRows) return
      setSelectedIds(checked ? visibleIds : [])
    },
    [canSelectRows, visibleIds],
  )

  const handleBulkDelete = useCallback(() => {
    if (!canBulkDelete || selectedIds.length === 0) return
    if (selectedIds.length > BULK_DELETE_MAX) {
      toast.error(`Chỉ được xoá tối đa ${BULK_DELETE_MAX} khách hàng mỗi lần`)
      return
    }
    const ids = [...selectedIds]
    const hidden = new Set(ids)
    // Ẩn ngay khỏi danh sách; lệnh xoá chỉ gửi sau 5 giây — bấm "Hoàn tác" thì không gửi gì.
    queryClient.setQueriesData<{ data: { id: number | string }[] }>({ queryKey: ["contacts", "page"] }, (d) =>
      d ? { ...d, data: d.data.filter((c) => !hidden.has(String(c.id))) } : d,
    )
    setSelectedIds([])
    setBulkDeleteOpen(false)
    deferWithUndo({
      message: `Đã xoá ${formatCount(ids.length, "khách hàng")}`,
      commit: () => commitContactDelete(ids, queryClient),
      commitOnUnload: () => ids.forEach((id) => sendKeepalive("DELETE", `/contacts/${id}`)),
      onUndo: () => queryClient.invalidateQueries({ queryKey: ["contacts"] }),
    })
  }, [canBulkDelete, queryClient, selectedIds])

  // Cap số trang hiển thị tại MAX_VISIBLE_PAGES — khớp giới hạn BE OFFSET.
  const cappedPages = Math.min(pages, MAX_VISIBLE_PAGES)
  const isCapped = pages > MAX_VISIBLE_PAGES

  const goToPage = useCallback(
    (target: number) => {
      // Nếu user nhập/click trang vượt cap → toast nhắc thu hẹp bộ lọc.
      if (target > MAX_VISIBLE_PAGES) {
        toast.info(
          "Vui lòng thu hẹp bộ lọc để xem dữ liệu cũ hơn",
        )
        const clamped = Math.max(1, Math.min(cappedPages, MAX_VISIBLE_PAGES))
        if (clamped !== page) commitFilters(appliedFilters, clamped)
        return
      }
      const clamped = Math.max(1, Math.min(cappedPages, target))
      if (clamped !== page) commitFilters(appliedFilters, clamped)
    },
    [cappedPages, page, appliedFilters, commitFilters],
  )

  const startIdx = total === 0 ? 0 : (page - 1) * CONTACTS_PAGE_SIZE + 1
  const endIdx = Math.min(page * CONTACTS_PAGE_SIZE, total)

  /* ---- Tab nhanh (chỉ là lối tắt đặt bộ lọc SẴN CÓ — không thêm điều kiện mới) ---- */
  const { user: me } = useAuth()
  const myId = me?.id != null ? String(me.id) : null
  const tabs: { key: QuickTab; label: string }[] = [{ key: "all", label: "Tất cả" }]
  if (canFilterAssignee && myId) tabs.push({ key: "mine", label: "Của tôi" })
  if (scoringOn) tabs.push({ key: "hot", label: "Khách nóng" })
  const activeTab = quickTabOf(appliedFilters, myId)
  const pickTab = (key: QuickTab) =>
    commitFilters(
      {
        ...appliedFilters,
        assignedTo: key === "mine" && myId ? myId : undefined,
        leadLabel: key === "hot" ? "hot" : undefined,
      },
      1,
    )

  /* ---- Sắp xếp: cùng 3 trường BE hỗ trợ (`SortField`) ---- */
  const sortValue = appliedFilters.sortBy ? `${appliedFilters.sortBy}:${appliedFilters.sortOrder ?? "asc"}` : "default"
  const sortOptions = SORT_OPTIONS.filter((o) => scoringOn || !o.value.startsWith("lead_score"))
  const pickSort = (v: string) => {
    if (v === "default") commitFilters({ ...appliedFilters, sortBy: undefined, sortOrder: undefined }, 1)
    else {
      const [by, order] = v.split(":")
      commitFilters({ ...appliedFilters, sortBy: by, sortOrder: order }, 1)
    }
  }

  /* ---- Tín hiệu: nhật ký Hoạt động AI của chính mình (cùng truy vấn với Trang chủ) ---- */
  const recentAi = useRecentAiActions()
  const aiByContact = useMemo(() => latestAiActionByContact(recentAi.data?.data ?? []), [recentAi.data])
  const today = todayVn()
  const signalsById = useMemo(
    () => new Map(contacts.map((c) => [c.id, contactSignals(c, aiByContact.get(String(c.id)), today)])),
    [contacts, aiByContact, today],
  )

  const tabsNode =
    tabs.length > 1 ? (
      <div role="tablist" aria-label="Xem nhanh" className="flex w-full items-center gap-1 overflow-x-auto sm:w-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            onClick={() => pickTab(t.key)}
            className={cn(
              "h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition max-sm:h-11",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
              activeTab === t.key
                ? "bg-[var(--muted)] text-foreground"
                : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    ) : null

  const sortNode = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="h-9 shrink-0 gap-1.5 text-sm max-sm:h-11 max-sm:flex-1" />}
      >
        <ArrowDownUp className="h-4 w-4" />
        Sắp xếp
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuRadioGroup value={sortValue} onValueChange={(v) => typeof v === "string" && pickSort(v)}>
          {sortOptions.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value} className="min-h-9 text-sm">
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="space-y-4">
      {/* Thanh trên: tiêu đề gọn (breadcrumb đã nằm ở topbar) + Xuất Excel / Thêm khách */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex min-w-0 items-baseline gap-2 text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          Khách hàng
          <span className="text-[15px] font-normal tabular-nums text-muted-foreground">
            {/* toLocaleString ở đây là NGĂN CÁCH NGHÌN cho SỐ NGUYÊN (đếm khách hàng). */}
            {/* Lỗi tải mà chưa có dữ liệu: không biết có bao nhiêu khách ⇒ "—", không nói "0 khách". */}
            {isLoading ? "…" : isError && contacts.length === 0 ? "—" : formatCount(total, "khách")}
          </span>
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canExport && (
            <Button
              variant="outline"
              className="h-9 gap-1.5 text-sm max-sm:h-11"
              disabled={isExporting}
              onClick={() => exportContacts(appliedFilters)}
            >
              {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
              <span className="hidden sm:inline">{isExporting ? "Đang xuất..." : "Xuất Excel"}</span>
              <span className="sm:hidden">Xuất</span>
            </Button>
          )}
          <Can perm="contacts.create">
            {/* nút chính = FAB dưới phải trên điện thoại; ẩn khi đang chọn hàng loạt (thanh hành động dính đáy dùng chung vị trí). */}
            <Button
              className={cn("h-9 gap-1.5 text-sm", MOBILE_FAB_CLASS, hasBulkBar && "max-sm:hidden")}
              onClick={() => router.push("/contacts/new")}
            >
              <Plus className="h-4 w-4" />
              Thêm khách
            </Button>
          </Can>
        </div>
      </div>

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Xoá ${selectedIds.length} khách hàng đã chọn?`}
        description="Khách sẽ biến khỏi danh sách ngay; bạn có 5 giây để bấm Hoàn tác trước khi xoá hẳn."
        confirmLabel="Xoá khách hàng"
        onConfirm={handleBulkDelete}
      />

      <BulkTransferContactsDialog
        open={bulkTransferOpen}
        onOpenChange={setBulkTransferOpen}
        contactIds={selectedIds}
        onDone={() => setSelectedIds([])}
      />

      <section
        aria-label="Danh sách khách hàng trong phạm vi"
        className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]"
      >
        {/* Hàng công cụ: tab nhanh · ô tìm · Lọc (popover, mọi điều kiện cũ) · Sắp xếp; dưới là chip điều kiện đang áp */}
        <div className="border-b border-[var(--border)] px-3 py-2.5 sm:px-4">
          <ContactsFilters
            searchInput={searchInput}
            onSearch={handleSearchInput}
            onFilterChange={setPendingFilter}
            onApply={handleApply}
            onReset={handleReset}
            stageId={pendingFilters.stageId}
            contactStatusId={pendingFilters.contactStatusId}
            sourceId={pendingFilters.sourceId}
            createdFrom={pendingFilters.createdFrom}
            createdTo={pendingFilters.createdTo}
            assignedTo={pendingFilters.assignedTo}
            projectId={pendingFilters.projectId}
            leadLabel={pendingFilters.leadLabel}
            showLeadFilter={scoringOn}
            showAssigneeFilter={canFilterAssignee}
            isDirty={isDirty}
            applied={appliedFilters}
            onRemoveApplied={handleRemoveAppliedFilter}
            leading={tabsNode}
            trailing={sortNode}
          />
        </div>

        {/* Thanh hành động hàng loạt — CHỈ hiện khi có dòng đã chọn. */}
        {hasBulkBar && (
          <>
            <div className="hidden flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--color-app-primary-soft)] px-4 py-2 sm:flex">
              <span className="text-sm font-semibold text-[var(--color-app-primary-ink)]">
                {selectedIds.length} đã chọn
              </span>
              <div className="ml-auto flex flex-wrap gap-2">
                {canBulkTransfer && (
                  <Button size="sm" variant="outline" className="h-8 bg-card text-sm" onClick={requestBulkTransfer}>
                    <Send className="mr-1 h-4 w-4" />
                    Chuyển cho... ({selectedIds.length})
                  </Button>
                )}
                {canBulkDelete && (
                  <Button size="sm" variant="destructive" className="h-8 text-sm" onClick={requestBulkDelete}>
                    <Trash2 className="mr-1 h-4 w-4" />
                    Xoá đã chọn ({selectedIds.length})
                  </Button>
                )}
              </div>
            </div>
            {/* điện thoại — thanh dính đáy; "Xoá" tách khỏi "Chuyển" (vào menu ⋯, luôn qua ConfirmDialog). */}
            <div className="sm:hidden">
              <MobileActionBar>
                <span className="self-center text-sm font-semibold text-[var(--color-app-primary-ink)]">
                  {selectedIds.length} đã chọn
                </span>
                {canBulkDelete && !canBulkTransfer && (
                  <Button variant="destructive" onClick={requestBulkDelete}>
                    <Trash2 className="mr-1 h-4 w-4" />
                    Xoá đã chọn ({selectedIds.length})
                  </Button>
                )}
                {canBulkDelete && canBulkTransfer && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="outline" size="icon" aria-label="Thao tác khác" />}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem variant="destructive" onClick={requestBulkDelete}>
                        <Trash2 className="size-4" />
                        Xoá đã chọn ({selectedIds.length})
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {canBulkTransfer && (
                  <Button onClick={requestBulkTransfer}>
                    <Send className="mr-1 h-4 w-4" />
                    Chuyển cho... ({selectedIds.length})
                  </Button>
                )}
              </MobileActionBar>
            </div>
          </>
        )}

        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : isError && contacts.length === 0 ? (
          <ErrorState
            className="m-4"
            title="Không tải được danh sách khách hàng"
            error={error}
            onRetry={() => void refetch()}
            retrying={isFetching}
          />
        ) : contacts.length === 0 ? (
          hasFilters ? (
            <EmptyState
              className="m-4"
              title="Không có khách nào khớp bộ lọc"
              message="Thử bỏ bớt điều kiện hoặc tìm bằng tên, số điện thoại khác."
              action={<Button variant="outline" onClick={handleReset}>Xoá bộ lọc</Button>}
            />
          ) : (
            <EmptyState
              className="m-4"
              title="Chưa có khách hàng nào"
              message="Thêm khách đầu tiên, hoặc bật Fanpage/Zalo OA để khách nhắn tin tự vào danh sách."
              action={
                <Can perm="contacts.create">
                  <Button variant="outline" onClick={() => router.push("/contacts/new")}>
                    <Plus className="h-4 w-4" />
                    Thêm khách
                  </Button>
                </Can>
              }
            />
          )
        ) : (
          <ShellResponsiveList
            table={
              <div className="relative overflow-x-auto">
                {isFetching && !isLoading ? (
                  <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-full bg-[var(--card)] px-2 py-1 text-sm text-muted-foreground shadow">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang tải...
                  </div>
                ) : null}
                <table className="w-full border-collapse">
                  <ContactsTableHeader
                    filters={appliedFilters}
                    onToggleSort={toggleSort}
                    showSelection={canSelectRows}
                    allSelected={allSelected}
                    onToggleSelectAll={toggleSelectAll}
                    showScore={scoringOn}
                  />
                  <tbody>
                    {contacts.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        contact={contact}
                        onNavigate={handleNavigate}
                        onHover={handleRowHover}
                        showSelection={canSelectRows}
                        selected={selectedIds.includes(contact.id)}
                        onToggleSelected={toggleSelected}
                        showScore={scoringOn}
                        signals={signalsById.get(contact.id) ?? EMPTY_SIGNALS}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            }
            cards={
              <div>
                {contacts.map((contact) => (
                  <ContactCard
                    key={contact.id}
                    contact={contact}
                    onNavigate={handleNavigate}
                    showSelection={canSelectRows}
                    selected={selectedIds.includes(contact.id)}
                    onToggleSelected={toggleSelected}
                    showScore={scoringOn}
                    signals={signalsById.get(contact.id) ?? EMPTY_SIGNALS}
                  />
                ))}
              </div>
            }
          />
        )}

        {/* Danh sách trống / lỗi tải: khung trống hoặc khung lỗi phía trên đã nói rồi — thanh phân trang mà ghi
            "Không có khách hàng" thì vừa lặp lại, vừa sai khi thật ra là lỗi tải (phát hiện bằng e2e/premium/break-it.mjs). */}
        {contacts.length > 0 && (
        <div className="border-t border-[var(--border)] px-4 py-2.5">
          <PaginationBar
            page={page}
            pages={cappedPages}
            total={total}
            startIdx={startIdx}
            endIdx={endIdx}
            onGoTo={goToPage}
            isFetching={isFetching && !isLoading}
            isCapped={isCapped}
          />
        </div>
        )}
      </section>
    </div>
  )
}

type QuickTab = "all" | "mine" | "hot"

/** Tab nào khớp bộ lọc ĐANG ÁP — chỉ xét 2 điều kiện tab đặt (người phụ trách, nhãn lead); khác đi thì không tab nào sáng. */
function quickTabOf(f: Pick<ContactFilters, "assignedTo" | "leadLabel">, myId: string | null): QuickTab | null {
  if (!f.assignedTo && !f.leadLabel) return "all"
  if (myId && f.assignedTo === myId && !f.leadLabel) return "mine"
  if (f.leadLabel === "hot" && !f.assignedTo) return "hot"
  return null
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Mặc định" },
  { value: "created_at:desc", label: "Mới tạo trước" },
  { value: "created_at:asc", label: "Cũ trước" },
  { value: "full_name:asc", label: "Tên A → Z" },
  { value: "full_name:desc", label: "Tên Z → A" },
  { value: "lead_score:desc", label: "Quan tâm cao trước" },
  { value: "lead_score:asc", label: "Quan tâm thấp trước" },
]

const EMPTY_SIGNALS: never[] = []

/**
 * `ContactsPageContent` dùng `useSearchParams()` (qua `useContactsUrlFilters`)
 * — Next.js 16 BẮT BUỘC bọc `<Suspense>` ở default export, nếu
 * không `next build` fail prerender.
 */
export default function ContactsPage() {
  return (
    <Suspense fallback={<ContactsPageFallback />}>
      <ContactsAccessGate />
    </Suspense>
  )
}

/**
 * Cổng quyền vào Danh bạ (middleware chỉ kiểm phiên): chờ `/auth/me`
 * xong rồi mới xét `contacts.view`, thiếu quyền → `<Forbidden />`. Đặt NGOÀI
 * `ContactsPageContent` để không gọi hook dữ liệu của trang khi chưa được phép.
 */
function ContactsAccessGate() {
  const { isLoading } = useAuth()
  const { can } = usePermissions()
  if (isLoading) return <ContactsPageFallback />
  if (!can("contacts.view")) return <Forbidden message="Cần quyền Xem khách hàng." />
  return <ContactsPageContent />
}

function ContactsPageFallback() {
  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="rounded-2xl border p-4 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}

/* ---------- Pagination component (inline) ---------- */

interface PaginationBarProps {
  page: number
  pages: number
  total: number
  startIdx: number
  endIdx: number
  onGoTo: (page: number) => void
  isFetching: boolean
  isCapped: boolean
}

function PaginationBar({
  page, pages, total, startIdx, endIdx, onGoTo, isFetching, isCapped,
}: PaginationBarProps) {
  const items = useMemo(() => buildPageItems(page, pages), [page, pages])

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">
        {total === 0
          ? "Không có khách hàng"
          : `Hiển thị ${startIdx.toLocaleString("vi-VN")}–${endIdx.toLocaleString("vi-VN")} / ${total.toLocaleString("vi-VN")} khách hàng`}
        {isFetching ? " · Đang tải..." : ""}
        {isCapped ? (
          <span className="ml-2 text-amber-700">
            · Hiển thị {pages} trang đầu — thu hẹp bộ lọc để xem dữ liệu cũ hơn
          </span>
        ) : null}
      </span>

      {pages > 1 && (
        <nav className="hidden flex-wrap items-center gap-1 sm:flex" aria-label="Phân trang">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={page === 1}
            onClick={() => onGoTo(1)}
            aria-label="Trang đầu"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={page === 1}
            onClick={() => onGoTo(page - 1)}
            aria-label="Trang trước"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {items.map((it, idx) =>
            it === "..." ? (
              <span
                key={`gap-${idx}`}
                className="px-1 text-muted-foreground"
                aria-hidden
              >
                …
              </span>
            ) : (
              <Button
                key={it}
                variant={it === page ? "soft" : "outline"}
                size="sm"
                className="h-8 min-w-8 px-2"
                onClick={() => onGoTo(it)}
                aria-label={`Trang ${it}`}
                aria-current={it === page ? "page" : undefined}
              >
                {it}
              </Button>
            ),
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={page === pages}
            onClick={() => onGoTo(page + 1)}
            aria-label="Trang sau"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={page === pages}
            onClick={() => onGoTo(pages)}
            aria-label="Trang cuối"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </nav>
      )}
      {pages > 1 && (
        <nav className="flex w-full items-center justify-between gap-2 sm:hidden" aria-label="Phân trang">
          <Button variant="outline" disabled={page === 1} onClick={() => onGoTo(page - 1)} aria-label="Trang trước">
            <ChevronLeft className="h-4 w-4" />
            Trước
          </Button>
          <span className="text-sm font-medium" aria-current="page">
            Trang {page}/{pages}
          </span>
          <Button variant="outline" disabled={page === pages} onClick={() => onGoTo(page + 1)} aria-label="Trang sau">
            Sau
            <ChevronRight className="h-4 w-4" />
          </Button>
        </nav>
      )}
    </div>
  )
}

/** Sinh danh sách số trang hiển thị: [1, "...", 4, 5, 6, "...", 100]. */
function buildPageItems(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const siblings = 1
  const left = Math.max(2, current - siblings)
  const right = Math.min(total - 1, current + siblings)
  const items: (number | "...")[] = [1]
  if (left > 2) items.push("...")
  for (let i = left; i <= right; i++) items.push(i)
  if (right < total - 1) items.push("...")
  items.push(total)
  return items
}
