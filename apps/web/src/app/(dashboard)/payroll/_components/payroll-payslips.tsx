"use client"

import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Loader2, FileSpreadsheet, Users, UserPlus, Calendar, ChevronLeft, ChevronRight, Upload, FilePlus2, MoreHorizontal } from "lucide-react"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { jobTitleSeniorityRank } from "@/lib/job-title-rank"
import { cn } from "@/lib/utils"
import { useRowHighlight } from "@/lib/use-row-highlight"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { type PayslipRow, MONTHS_VI, displayRevenue, fmt, formatMonth, getCurrentMonth } from "./payroll-payslips-shared"
import { PayslipsDesktopTable } from "./payroll-payslips-table"
import { PayslipsMobileList } from "./payroll-payslips-cards"
import { AddToPeriodDialog, PayslipDetailDialog, RemovePayslipDialog } from "./payroll-payslips-dialogs"
import { ImportPayslipsDialog } from "./payroll-payslips-import-dialog"
import { PayslipEditDialog } from "./payroll-payslips-edit-dialog"

// Test `payroll-payslip-gates` import các hàm gate từ file này — giữ re-export.
export { canApproveNow, canEditPayslip, canRemoveFromPeriod } from "./payroll-payslips-shared"

// Sắp xếp nhân viên TRONG cùng một team theo cơ cấu tổ chức (dùng cho thứ tự
// MẶC ĐỊNH của bảng — chưa bấm sắp xếp cột). Đồng bộ với tab Nhân viên
// (`payroll-employees.tsx`):
//   1. Trưởng nhóm đứng đầu (user_id === team_lead_id).
//   2. Cấp bậc theo TÊN chức danh thực tế (Trưởng nhóm → Chuyên viên chính →
//      Chuyên viên → Nhân viên), KHÔNG dùng mã/ký hiệu — xem `jobTitleSeniorityRank`.
//      Fallback `position` (text cũ) khi chưa gán `job_title_name`.
//   3. Cùng cấp: tên A → Z (tiếng Việt).
function sortWithinTeam(rows: PayslipRow[]): PayslipRow[] {
  return [...rows].sort((a, b) => {
    const la = a.employee?.user_id === a.employee?.team_lead_id ? 0 : 1
    const lb = b.employee?.user_id === b.employee?.team_lead_id ? 0 : 1
    if (la !== lb) return la - lb
    const ra = jobTitleSeniorityRank(a.employee?.job_title_name ?? a.employee?.position)
    const rb = jobTitleSeniorityRank(b.employee?.job_title_name ?? b.employee?.position)
    if (ra !== rb) return rb - ra // cấp cao đứng trước
    return (a.employee?.user?.full_name ?? "").localeCompare(
      b.employee?.user?.full_name ?? "",
      "vi",
    )
  })
}

const MOBILE_SORT_OPTIONS = [
  { value: "default", label: "Mặc định" },
  { value: "full_name:asc", label: "Tên A → Z" },
  { value: "full_name:desc", label: "Tên Z → A" },
  { value: "total:desc", label: "Thực nhận cao → thấp" },
  { value: "total:asc", label: "Thực nhận thấp → cao" },
]

export function PayrollPayslips() {
  const { can } = usePermissions()
  const canManage = can("payroll.manage")
  const [month, setMonth] = useState(getCurrentMonth())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerYear, setPickerYear] = useState(() => new Date().getFullYear())
  const [filterTeam, setFilterTeam] = useState("")
  const [search, setSearch] = useState("")
  const { selectRow, rowHighlightClass } = useRowHighlight<number>()
  const [detailRow, setDetailRow] = useState<PayslipRow | null>(null)
  const [editRow, setEditRow] = useState<PayslipRow | null>(null)
  const [removeRow, setRemoveRow] = useState<PayslipRow | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const qc = useQueryClient()

  const { data, isLoading, isError } = useQuery<PayslipRow[]>({
    queryKey: ["payroll-payslips", month],
    queryFn: async () => {
      const res = await apiClient.get<PayslipRow[]>("/payslips", { params: { month } })
      return res.data
    },
  })

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<{ generated: number; skipped: number }>(
        "/payslips/generate", { month },
      )
      return res.data
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["payroll-payslips", month] })
      if (result.generated === 0) {
        toast.info('Không tạo được phiếu nào. Hãy chắc nhân viên có trạng thái "Đang làm việc".')
      } else {
        toast.success(
          `Đã tạo ${result.generated} phiếu lương${result.skipped > 0 ? `, bỏ qua ${result.skipped} phiếu đã duyệt` : ""}.`,
        )
      }
    },
    onError: () => toast.error("Không thể tạo phiếu lương. Vui lòng thử lại."),
  })

  const approveMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiClient.patch(`/payslips/${id}/approve`, { action: "approve" })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payroll-payslips", month] })
      toast.success("Đã duyệt phiếu lương.")
    },
    onError: () => toast.error("Không thể duyệt phiếu lương. Vui lòng thử lại."),
  })

  // Loại 1 người khỏi kỳ (soft-delete) — phiếu của tháng đang xem bị xóa, người này
  // không tự quay lại khi "Tạo phiếu lương"; tháng khác + hồ sơ NV không ảnh hưởng.
  const removeMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiClient.delete(`/payslips/${id}`)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["payroll-payslips", month] })
      toast.success("Đã loại nhân viên khỏi kỳ lương này.")
      setRemoveRow(null)
    },
    onError: () =>
      toast.error(
        "Không thể loại khỏi kỳ. Phiếu đã duyệt cần quyền Kế toán/Super Admin.",
      ),
  })

  async function downloadFile(id: number, name: string, kind: "pdf" | "excel") {
    const ext = kind === "pdf" ? "pdf" : "xlsx"
    try {
      const res = await apiClient.get(`/payslips/${id}/${kind}`, { responseType: "blob" })
      const blob = res.data as Blob
      if (!blob || blob.size === 0) {
        toast.error("Không tải được tệp.")
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `phieu-luong-${name}-${month}.${ext}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error("Không thể tải tệp. Vui lòng thử lại.")
    }
  }

  const [bulkExporting, setBulkExporting] = useState(false)
  async function downloadBulkExcel() {
    setBulkExporting(true)
    try {
      const res = await apiClient.get("/payslips/excel-bulk", {
        params: { month },
        responseType: "blob",
      })
      const blob = res.data as Blob
      if (!blob || blob.size === 0) {
        toast.error("Không tải được tệp.")
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `phieu-luong-ky-${month}.xlsx`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err: unknown) {
      // Lỗi với responseType:'blob' → body lỗi là Blob (JSON) → đọc message BE (vd 404 kỳ rỗng).
      let msg = "Không thể xuất Excel cả kỳ. Vui lòng thử lại."
      try {
        const data = (err as { response?: { data?: unknown } })?.response?.data
        if (data instanceof Blob) {
          const parsed = JSON.parse(await data.text()) as { message?: string }
          if (parsed.message) msg = parsed.message
        }
      } catch {
        /* giữ message mặc định */
      }
      toast.error(msg)
    } finally {
      setBulkExporting(false)
    }
  }

  const [listExporting, setListExporting] = useState(false)
  async function downloadEmployeeListExcel() {
    setListExporting(true)
    try {
      const res = await apiClient.get("/payslips/excel-list", {
        params: { month },
        responseType: "blob",
      })
      const blob = res.data as Blob
      if (!blob || blob.size === 0) {
        toast.error("Không tải được tệp.")
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `danh-sach-luong-ky-${month}.xlsx`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err: unknown) {
      // Lỗi với responseType:'blob' → body lỗi là Blob (JSON) → đọc message BE (vd 404 kỳ rỗng).
      let msg = "Không thể xuất Excel danh sách nhân viên. Vui lòng thử lại."
      try {
        const data = (err as { response?: { data?: unknown } })?.response?.data
        if (data instanceof Blob) {
          const parsed = JSON.parse(await data.text()) as { message?: string }
          if (parsed.message) msg = parsed.message
        }
      } catch {
        /* giữ message mặc định */
      }
      toast.error(msg)
    } finally {
      setListExporting(false)
    }
  }

  // BE đã sắp xếp theo team (team lead đứng trước).
  const allPayslips = data ?? []
  // Danh sách Team cho dropdown bộ lọc — nguồn DUY NHẤT là Cài đặt > Team (bảng `teams`),
  // tự đồng bộ khi thêm/đổi tên/xoá/deactive team — không suy từ phiếu lương đã tải.
  // value = String(team_lead_id) để khớp `filterTeam` (lọc theo team_lead user id).
  const { data: teamsForFilter = [] } = useTeamsForFilter()
  const teamOptions = useMemo(
    () => teamsForFilter.map((t) => ({ id: String(t.team_lead_id), name: t.name })),
    [teamsForFilter],
  )
  // Lọc theo team + tìm tên ở client (dữ liệu là mảng đầy đủ, không phân trang BE).
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  function handleSort(field: string) {
    if (sortBy === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSortBy(field)
      setSortDir("asc")
    }
  }

  // Điện thoại: Select "Sắp xếp theo" map lên đúng state sortBy/sortDir của bảng desktop.
  const mobileSortKey = `${sortBy ?? ""}:${sortDir}`
  const mobileSortValue = MOBILE_SORT_OPTIONS.some((o) => o.value === mobileSortKey) ? mobileSortKey : "default"

  const payslips = useMemo(() => {
    const kw = search.trim().toLowerCase()
    const filtered = allPayslips.filter((p) => {
      if (filterTeam && String(p.employee?.team_lead_id ?? "") !== filterTeam) return false
      if (
        kw &&
        !(p.employee?.user?.full_name ?? "").toLowerCase().includes(kw) &&
        !(p.employee?.employee_code ?? "").toLowerCase().includes(kw)
      ) return false
      return true
    })
    if (!sortBy) {
      // Thứ tự mặc định: GIỮ thứ tự team do BE sắp (3 team chính → 5 team khác →
      // không team), nhưng sắp xếp nhân viên TRONG mỗi team theo cấp bậc chức danh
      // rồi tên. Map giữ thứ tự xuất hiện đầu tiên của team_lead_id = thứ tự team BE.
      const groups = new Map<string, PayslipRow[]>()
      for (const p of filtered) {
        const key = String(p.employee?.team_lead_id ?? "__none__")
        const arr = groups.get(key)
        if (arr) arr.push(p)
        else groups.set(key, [p])
      }
      return Array.from(groups.values()).flatMap(sortWithinTeam)
    }
    const dir = sortDir === "asc" ? 1 : -1
    const val = (p: PayslipRow): string | number => {
      switch (sortBy) {
        case "employee_code": return (p.employee?.employee_code ?? "").toLowerCase()
        case "full_name": return (p.employee?.user?.full_name ?? "").toLowerCase()
        case "position": return (p.employee?.job_title_name ?? "").toLowerCase()
        case "team": return (p.employee?.team_name ?? "").toLowerCase()
        case "department": return (p.employee?.department ?? "").toLowerCase()
        case "status": return p.status ?? ""
        case "base_salary": return Number(p.base_salary ?? 0)
        case "sales_personal": return displayRevenue(p)
        case "cong_thuong": return Number(p.cong_thuong ?? 0)
        case "tong_giam_tru": return Number(p.tong_giam_tru ?? 0)
        case "total": return Number(p.total ?? 0)
        default: return 0
      }
    }
    return [...filtered].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      if (typeof av === "number" && typeof bv === "number") return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv), "vi")
    })
  }, [allPayslips, filterTeam, search, sortBy, sortDir])

  // Tổng cộng các cột tiền (dòng cuối bảng) — Number an toàn (tổng quỹ lương < 2^53).
  const totals = useMemo(() => {
    const s = (key: keyof PayslipRow) =>
      payslips.reduce((acc, p) => acc + Number((p[key] as string) ?? 0), 0)
    return {
      base_salary: s("base_salary"),
      insurance_base: s("insurance_base"),
      base_salary_actual: s("base_salary_actual"),
      training_salary: s("training_salary"),
      probation_allowance: s("probation_allowance"),
      cong_lcb: s("cong_lcb"),
      sales_personal: payslips.reduce((acc, p) => acc + displayRevenue(p), 0),
      bonus_sales_personal: s("bonus_sales_personal"),
      bonus_milestone: s("bonus_milestone"),
      bonus_cskh_team: s("bonus_cskh_team"),
      bonus_referral: s("bonus_referral"),
      holiday_bonus: s("holiday_bonus"),
      cong_thuong: s("cong_thuong"),
      advances: s("advances"),
      insurance_total: s("insurance_total"),
      tax_total: s("tax_total"),
      tong_giam_tru: s("tong_giam_tru"),
      total: s("total"),
    }
  }, [payslips])
  const canGenerate = canManage
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          <Popover
            open={pickerOpen}
            onOpenChange={(o) => {
              // Khi MỞ picker: đồng bộ năm hiển thị về năm của tháng đang chọn
              // (tránh mất highlight tháng selected khi tháng đang chọn khác năm hiện tại).
              if (o) setPickerYear(Number(month.split("-")[0]))
              setPickerOpen(o)
            }}
          >
            <PopoverTrigger
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-11 w-44 justify-start rounded-xl max-sm:w-auto max-sm:flex-1",
              )}
            >
              <Calendar className="mr-2 size-4 shrink-0" />
              Tháng {formatMonth(month)}
            </PopoverTrigger>
            <PopoverContent className="w-64 p-3" align="start">
              {/* Header: năm + nút ◀▶ */}
              <div className="mb-3 flex items-center justify-between">
                <Button variant="ghost" size="icon" className="h-7 w-7 max-sm:size-11" aria-label="Năm trước" onClick={() => setPickerYear((y) => y - 1)}>
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="font-semibold">{pickerYear}</span>
                <Button variant="ghost" size="icon" className="h-7 w-7 max-sm:size-11" aria-label="Năm sau" onClick={() => setPickerYear((y) => y + 1)}>
                  <ChevronRight className="size-4" />
                </Button>
              </div>
              {/* Grid 12 tháng */}
              <div className="grid grid-cols-4 gap-1">
                {MONTHS_VI.map((label, i) => {
                  const ym = `${pickerYear}-${String(i + 1).padStart(2, "0")}`
                  const isSelected = ym === month
                  const isCurrentMonth = ym === getCurrentMonth()
                  return (
                    <Button
                      key={i}
                      variant={isSelected ? "soft" : "ghost"}
                      size="sm"
                      className={cn(
                        "relative h-8 text-xs max-sm:min-h-11",
                        isCurrentMonth && !isSelected && "border border-dashed border-primary/40",
                      )}
                      aria-label={`Tháng ${i + 1} năm ${pickerYear}`}
                      onClick={() => { setMonth(ym); setPickerOpen(false) }}
                    >
                      {label}
                      {isCurrentMonth && !isSelected && (
                        <span className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary/60" />
                      )}
                    </Button>
                  )
                })}
              </div>
            </PopoverContent>
          </Popover>
          {/* Điện thoại: "⋯" cạnh chọn tháng gom 4 hành động phụ (giữ nguyên gate/disabled của nút desktop). */}
          <div className="sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label="Thao tác khác" />}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem
                  className="max-sm:min-h-11"
                  disabled={listExporting || allPayslips.length === 0}
                  onClick={() => void downloadEmployeeListExcel()}
                >
                  {listExporting ? <Loader2 className="animate-spin" /> : <Users />}
                  Xuất Excel danh sách nhân viên
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="max-sm:min-h-11"
                  disabled={bulkExporting || allPayslips.length === 0}
                  onClick={() => void downloadBulkExcel()}
                >
                  {bulkExporting ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
                  Xuất Excel cả kỳ
                </DropdownMenuItem>
                {canGenerate && (
                  <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setAddOpen(true)}>
                    <UserPlus /> Thêm người vào kỳ
                  </DropdownMenuItem>
                )}
                {canGenerate && (
                  <DropdownMenuItem className="max-sm:min-h-11" onClick={() => setImportOpen(true)}>
                    <Upload /> Nhập Excel
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* Desktop: Team inline. Điện thoại: Team + Sắp xếp vào bảng "Bộ lọc". */}
          <MobileFilterSheet
            activeCount={(filterTeam ? 1 : 0) + (sortBy ? 1 : 0)}
            onReset={() => { setFilterTeam(""); setSortBy(null); setSortDir("asc") }}
          >
            <Select
              value={filterTeam || "all"}
              onValueChange={(v) => {
                if (typeof v === "string") setFilterTeam(v === "all" ? "" : v)
              }}
            >
              <SelectTrigger className="h-11 w-52 rounded-xl max-sm:w-full">
                <SelectValue placeholder="Tất cả team">
                  {(v) => {
                    if (typeof v !== "string" || !v || v === "all") return "Tất cả team"
                    return teamOptions.find((t) => t.id === v)?.name ?? "Tất cả team"
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả team</SelectItem>
                {teamOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Chỉ điện thoại (desktop sắp xếp bằng tiêu đề cột) — dùng đúng state sortBy/sortDir. */}
            <div className="flex flex-col gap-1.5 sm:hidden">
              <span className="px-1 text-xs font-medium text-muted-foreground">Sắp xếp theo</span>
              <Select
                value={mobileSortValue}
                onValueChange={(v) => {
                  if (typeof v !== "string") return
                  if (v === "default") { setSortBy(null); setSortDir("asc"); return }
                  const [field, dir] = v.split(":")
                  setSortBy(field ?? null)
                  setSortDir(dir === "desc" ? "desc" : "asc")
                }}
              >
                <SelectTrigger className="h-11 w-full rounded-xl">
                  <SelectValue placeholder="Mặc định">
                    {(v) => MOBILE_SORT_OPTIONS.find((o) => o.value === v)?.label ?? "Mặc định"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {MOBILE_SORT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </MobileFilterSheet>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo tên nhân viên…"
            className="h-11 w-56 rounded-xl max-sm:order-last max-sm:w-full"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 max-sm:contents">
          <Button
            variant="outline"
            className="h-11 max-sm:hidden"
            onClick={() => void downloadEmployeeListExcel()}
            disabled={listExporting || allPayslips.length === 0}
            title="Xuất Excel danh sách nhân viên (1 sheet, nhóm theo Phòng ban → Team Lead → Nhân viên)"
          >
            {listExporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Users className="mr-2 h-4 w-4" />
            )}
            Xuất Excel danh sách nhân viên
          </Button>
          <Button
            variant="outline"
            className="h-11 max-sm:hidden"
            onClick={() => void downloadBulkExcel()}
            disabled={bulkExporting || allPayslips.length === 0}
            title="Xuất Excel tất cả phiếu lương trong kỳ (mỗi nhân viên 1 sheet)"
          >
            {bulkExporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="mr-2 h-4 w-4" />
            )}
            Xuất Excel cả kỳ
          </Button>
          {canGenerate && (
            <Button
              variant="outline"
              className="h-11 max-sm:hidden"
              onClick={() => setAddOpen(true)}
              title="Thêm 1 nhân viên vào kỳ lương đang xem"
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Thêm người vào kỳ
            </Button>
          )}
          {canGenerate && (
            <Button
              variant="outline"
              className="h-11 max-sm:hidden"
              onClick={() => setImportOpen(true)}
              title="Nhập phiếu lương từ file Excel theo Template — xác định NV theo Mã nhân viên"
            >
              <Upload className="mr-2 h-4 w-4" />
              Nhập Excel
            </Button>
          )}
          {canGenerate && (
            <Button
              className={cn("h-11", MOBILE_FAB_CLASS)}
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
            >
              {generateMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FilePlus2 className="mr-2 h-4 w-4" />
              )}
              <span className="sm:hidden">Tạo phiếu</span>
              <span className="max-sm:hidden">Tạo phiếu lương</span>
            </Button>
          )}
        </div>
      </div>

      {!isLoading && !isError && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground max-sm:hidden">
          <span>
            <strong className="text-foreground">{payslips.length}</strong> phiếu
            {(filterTeam || search) && allPayslips.length !== payslips.length
              ? ` (lọc từ ${allPayslips.length})`
              : ""}
          </span>
          <span>
            Tổng thực nhận:{" "}
            <strong className="text-[var(--color-app-primary-ink)]">{fmt(totals.total)}</strong>
          </span>
        </div>
      )}

      <ShellResponsiveList
        table={
          <PayslipsDesktopTable
            payslips={payslips}
            isLoading={isLoading}
            isError={isError}
            month={month}
            totals={totals}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={handleSort}
            can={can}
            canManage={canManage}
            approving={approveMutation.isPending}
            onApprove={(id) => approveMutation.mutate(id)}
            onEdit={setEditRow}
            onDetail={setDetailRow}
            onRemove={setRemoveRow}
            onDownload={downloadFile}
            rowHighlightClass={rowHighlightClass}
            selectRow={selectRow}
          />
        }
        cards={
          <PayslipsMobileList
            payslips={payslips}
            isLoading={isLoading}
            isError={isError}
            month={month}
            totalAll={totals.total}
            filteredFrom={(filterTeam || search) && allPayslips.length !== payslips.length ? allPayslips.length : null}
            can={can}
            canManage={canManage}
            approving={approveMutation.isPending}
            onApprove={(id) => approveMutation.mutate(id)}
            onEdit={setEditRow}
            onDetail={setDetailRow}
            onRemove={setRemoveRow}
            onDownload={downloadFile}
          />
        }
      />

      {editRow && (
        <PayslipEditDialog
          row={editRow}
          month={month}
          onClose={() => setEditRow(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["payroll-payslips", month] })
            setEditRow(null)
          }}
        />
      )}

      <PayslipDetailDialog row={detailRow} onClose={() => setDetailRow(null)} />

      {removeRow && (
        <RemovePayslipDialog
          row={removeRow}
          month={month}
          pending={removeMutation.isPending}
          onClose={() => setRemoveRow(null)}
          onConfirm={() => removeMutation.mutate(removeRow.id)}
        />
      )}

      {addOpen && (
        <AddToPeriodDialog month={month} onClose={() => setAddOpen(false)} />
      )}

      {importOpen && (
        <ImportPayslipsDialog
          month={month}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void qc.invalidateQueries({ queryKey: ["payroll-payslips", month] })
          }}
        />
      )}
    </div>
  )
}
