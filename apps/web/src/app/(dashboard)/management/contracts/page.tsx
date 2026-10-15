"use client"

import { useState, useRef, useEffect } from "react"
import { useDepartments } from "@/hooks/use-departments"
import {
  useContracts,
  useCreateContract,
  useUpdateContract,
  useDeleteContract,
  useUploadContractFile,
  useDeleteContractFile,
  useViewContractFile,
  CONTRACTS_PAGE_SIZE,
} from "@/hooks/use-contracts"
import type { Contract, ContractStatus } from "@/hooks/use-contracts"
import { useEmployees } from "@/hooks/use-employees"
import type { Employee } from "@/hooks/use-employees"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { ShellTabsContent as TabsContent, ShellTabs as Tabs, ShellTabsList as TabsList, ShellTabsTrigger as TabsTrigger } from "@/components/app-shell/tabs"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"
import { ContractTemplatesTab } from "./_components/contract-templates-tab"
import { ContractStatsDialog } from "./_components/contract-stats-dialog"
import { formatDate, isoToVnDate, autoMaskVnDate } from "@/lib/format"
import { teamColorClass } from "@/lib/team-style"
import { cn } from "@/lib/utils"
import { useRowHighlight } from "@/lib/use-row-highlight"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectContent,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { toast } from "sonner"
import {
  Loader2,
  Plus,
  Eye,
  MoreHorizontal,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  FileUp,
  FileText,
  BarChart3,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react"

// ─── Constants ───────────────────────────────────────────────────────────────

// Nhãn hiển thị: 4 loại HĐLĐ hiện hành + 4 slug cũ (legacy) để hồ sơ cũ
// + bộ lọc vẫn hiển thị đúng tên thay vì raw slug.
const CONTRACT_TYPE_LABELS: Record<string, string> = {
  hdld_vo_thoi_han: "HĐLĐ vô thời hạn",
  hdld_1: "HĐLĐ 1",
  hdld_2: "HĐLĐ 2",
  hdld_3: "HĐLĐ 3",
  // Legacy (chỉ để hiển thị/lọc giá trị cũ — KHÔNG nằm trong dropdown chọn mới):
  thu_viec: "Thử việc",
  chinh_thuc: "Chính thức",
  co_thoi_han: "Có thời hạn",
  khong_thoi_han: "Không thời hạn",
}
// Bộ lọc "Loại HĐ" map qua TOÀN BỘ (gồm legacy) — lọc được mọi giá trị đang tồn tại.
const CONTRACT_TYPES = Object.keys(CONTRACT_TYPE_LABELS)
// Dropdown chọn loại khi Thêm/Sửa hợp đồng — CHỈ 4 loại HĐLĐ hiện hành.
const CONTRACT_TYPE_OPTIONS = ["hdld_vo_thoi_han", "hdld_1", "hdld_2", "hdld_3"]
const DEFAULT_CONTRACT_TYPE = "hdld_1"

const STATUS_META: Record<ContractStatus, { label: string; cls: string }> = {
  active: { label: "Còn hiệu lực", cls: "bg-green-100 text-green-800" },
  expiring: { label: "Sắp hết hạn", cls: "bg-amber-100 text-amber-800" },
  expired: { label: "Đã hết hạn", cls: "bg-red-100 text-red-800" },
  terminated: { label: "Đã chấm dứt", cls: "bg-slate-200 text-slate-700" },
  no_contract: { label: "Chưa có hợp đồng", cls: "bg-slate-100 text-slate-500" },
}

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "active", label: "Còn hiệu lực" },
  { value: "expiring", label: "Sắp hết hạn" },
  { value: "expired", label: "Đã hết hạn" },
  { value: "terminated", label: "Đã chấm dứt" },
  { value: "no_contract", label: "Chưa có hợp đồng" },
]

const EMPLOYMENT_FILTERS: { value: string; label: string }[] = [
  { value: "working", label: "Đang làm việc" },
  { value: "resigned", label: "Đã thôi việc" },
]

function genderLabel(g: string | null): string {
  if (g === "M") return "Nam"
  if (g === "F") return "Nữ"
  return "—"
}

function contractTypeLabel(t: string | null): string {
  if (!t) return "—"
  return CONTRACT_TYPE_LABELS[t] ?? t
}

// Dòng có hợp đồng thật (id non-null) — dùng cho Sửa / Chi tiết / Xoá.
type ExistingContract = Omit<
  Contract,
  "id" | "contract_type" | "signed_date" | "created_at" | "updated_at"
> & {
  id: number
  contract_type: string
  signed_date: string
  created_at: string
  updated_at: string
}

function asExisting(c: Contract): ExistingContract | null {
  if (
    c.id == null ||
    c.contract_type == null ||
    c.signed_date == null ||
    c.created_at == null ||
    c.updated_at == null
  ) {
    return null
  }
  return c as ExistingContract
}

// Nhân viên tối thiểu để prefill popup "Thêm hợp đồng" — tương thích cả Employee lẫn ContractEmployee.
interface PickedEmployee {
  id: number
  full_name: string | null
  email: string | null
  employee_code: string
  position: string | null
  department: string | null
  job_title_name: string | null
}

/** Ảnh đại diện nhân viên — img + fallback chữ cái đầu (đồng bộ /management/employees). */
function EmployeeAvatar({
  name,
  avatarUrl,
}: {
  name: string | null
  avatarUrl: string | null
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name ?? "NV"}
        className="h-8 w-8 rounded-full object-cover"
        onError={(e) => {
          e.currentTarget.style.display = "none"
        }}
      />
    )
  }
  const initials = (name ?? "?")
    .split(" ")
    .filter(Boolean)
    .slice(-2)
    .map((s) => s[0].toUpperCase())
    .join("")
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-700">
      {initials}
    </span>
  )
}

// DD/MM/YYYY → ISO (giữ timezone VN, tránh lệch ngày). Trả null nếu rỗng/sai.
function vnDateToIso(vn: string): string | null {
  const t = vn.trim()
  if (!t) return null
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return null
  const iso = new Date(t.split("/").reverse().join("-") + "T00:00:00+07:00")
  return isNaN(iso.getTime()) ? null : iso.toISOString()
}

function daysRemainingDisplay(c: Contract): { text: string; cls: string } {
  if (c.is_terminated || c.days_remaining === null)
    return { text: "—", cls: "text-muted-foreground" }
  const d = c.days_remaining
  if (d < 0) return { text: `Quá ${Math.abs(d)} ngày`, cls: "text-red-600 font-medium" }
  if (d <= 30) return { text: `${d} ngày`, cls: "text-amber-700 font-medium" }
  return { text: `${d} ngày`, cls: "text-green-700" }
}

// ─── Page ────────────────────────────────────────────────────────────────────

function ContractsPageContent() {
  const DEPARTMENTS = useDepartments()
  const { can } = usePermissions()
  const canList = can("contracts.view")
  const canWrite = can("contracts.manage")
  const canDelete = can("contracts.manage")

  const { selectRow, rowHighlightClass } = useRowHighlight<number>()
  const [search, setSearch] = useState("")
  const [department, setDepartment] = useState("")
  const [status, setStatus] = useState("")
  const [contractType, setContractType] = useState("")
  const [employmentStatus, setEmploymentStatus] = useState("")
  const [filterTeam, setFilterTeam] = useState("")
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<string | undefined>(undefined)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  // Nguồn dropdown "Team" — lấy từ bảng teams (Cài đặt > Team), luôn đồng bộ khi thêm/sửa/xoá team.
  // includeUnled:true để hiện cả team chưa gán Người phụ trách nhưng có NV gán trực tiếp;
  // filter gửi lên BE = id team (KHÔNG team_lead_id).
  const { data: teamsForFilter = [] } = useTeamsForFilter({ includeUnled: true })

  const { data, isLoading, isFetching } = useContracts({
    search: search || undefined,
    department: department || undefined,
    status: status || undefined,
    contract_type: contractType || undefined,
    employment_status: employmentStatus || undefined,
    team: filterTeam || undefined,
    page,
    sort_by: sortBy,
    sort_dir: sortBy ? sortDir : undefined,
  })

  const [addOpen, setAddOpen] = useState(false)
  const [addForEmployee, setAddForEmployee] = useState<PickedEmployee | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [editContract, setEditContract] = useState<ExistingContract | null>(null)
  const [detailContract, setDetailContract] = useState<ExistingContract | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ExistingContract | null>(null)
  const [tab, setTab] = useState("contracts")

  if (!canList) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Bạn không có quyền truy cập trang Quản lý hợp đồng.
      </div>
    )
  }

  const rows = data?.data ?? []
  const totalPages = data?.pagination.total_pages ?? 0
  const total = data?.pagination.total ?? 0
  // Clamp trang hiện tại khi filter thu hẹp tổng số trang (tránh kẹt ở trang trống).
  const safePage = Math.min(page, totalPages || 1)
  const fromRow = total === 0 ? 0 : (safePage - 1) * CONTRACTS_PAGE_SIZE + 1
  const toRow = Math.min(safePage * CONTRACTS_PAGE_SIZE, total)
  const hasActiveFilters = !!(
    search ||
    department ||
    status ||
    contractType ||
    employmentStatus ||
    filterTeam
  )

  // Số bộ lọc đang bật TRONG sheet (không tính ô tìm kiếm, nằm ngoài).
  const activeFilterCount = [department, status, contractType, employmentStatus, filterTeam].filter(Boolean).length

  const resetPage = () => setPage((p) => (p === 1 ? p : 1))
  const resetFilters = () => {
    setSearch("")
    setDepartment("")
    setStatus("")
    setContractType("")
    setEmploymentStatus("")
    setFilterTeam("")
    resetPage()
  }
  const closeAdd = () => {
    setAddOpen(false)
    setAddForEmployee(null)
  }

  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(field)
      setSortDir("asc")
    }
    setPage(1)
  }

  const SortIcon = ({ field }: { field: string }) => {
    if (sortBy !== field) return <ArrowUpDown className="ml-1 inline size-3 opacity-40" />
    return sortDir === "asc"
      ? <ArrowUp className="ml-1 inline size-3" />
      : <ArrowDown className="ml-1 inline size-3" />
  }

  return (
    <div className="space-y-4">
      <ShellPageHeader
        title="Quản lý hợp đồng"
        icon={FileText}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setStatsOpen(true)}
              className="gap-2"
            >
              <BarChart3 className="size-4" />
              <span className="sm:hidden">Thống kê</span>
              <span className="max-sm:hidden">Thống kê hợp đồng</span>
            </Button>
            {canWrite && (
              <Button
                onClick={() => setAddOpen(true)}
                className={cn(MOBILE_FAB_CLASS, "gap-2", tab !== "contracts" && "max-sm:hidden")}
              >
                <Plus className="size-4" /> Thêm hợp đồng
              </Button>
            )}
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="w-full">
        <TabsList>
          <TabsTrigger value="contracts">Hợp đồng nhân viên</TabsTrigger>
          <TabsTrigger value="templates">Hồ sơ mẫu hợp đồng</TabsTrigger>
        </TabsList>
        <TabsContent value="contracts" className="mt-4 space-y-4">

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Tìm theo mã / tên / email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            resetPage()
          }}
          className="w-full sm:max-w-xs"
        />
        <MobileFilterSheet
          activeCount={activeFilterCount}
          onReset={resetFilters}
        >
        <Select
          value={department}
          onValueChange={(v) => {
            setDepartment(v ?? "")
            resetPage()
          }}
        >
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Tất cả bộ phận">
              {(v) => (typeof v === "string" && v ? v : "Tất cả bộ phận")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả bộ phận</SelectItem>
            {DEPARTMENTS.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={contractType}
          onValueChange={(v) => {
            setContractType(v ?? "")
            resetPage()
          }}
        >
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue placeholder="Tất cả loại HĐ">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả loại HĐ"
                return CONTRACT_TYPE_LABELS[v] ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả loại HĐ</SelectItem>
            {CONTRACT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {CONTRACT_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={employmentStatus}
          onValueChange={(v) => {
            setEmploymentStatus(v ?? "")
            resetPage()
          }}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Tất cả tình trạng">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả tình trạng"
                return EMPLOYMENT_FILTERS.find((s) => s.value === v)?.label ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả tình trạng</SelectItem>
            {EMPLOYMENT_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v ?? "")
            resetPage()
          }}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Tất cả trạng thái HĐ">
              {(v) => {
                if (typeof v !== "string" || !v) return "Tất cả trạng thái HĐ"
                return STATUS_FILTERS.find((s) => s.value === v)?.label ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Tất cả trạng thái HĐ</SelectItem>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filterTeam || "__all__"}
          onValueChange={(v) => {
            setFilterTeam(v === "__all__" || !v ? "" : v)
            resetPage()
          }}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Tất cả team">
              {(v) => {
                if (typeof v !== "string" || !v || v === "__all__") return "Tất cả team"
                // value = id team (KHÔNG team_lead_id — team chưa gán Người phụ trách thì không có team_lead_id).
                return teamsForFilter.find((t) => String(t.id) === v)?.name ?? null
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Tất cả team</SelectItem>
            {teamsForFilter.map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5 max-sm:hidden sm:w-auto"
          disabled={!hasActiveFilters}
          onClick={resetFilters}
        >
          <RotateCcw className="size-4" /> Đặt lại
        </Button>
        </MobileFilterSheet>
      </div>

      {(() => {
        const desktopTable = (
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-muted-foreground">
              <th className="w-10 px-3 py-2 font-medium">Ảnh</th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("employee_code")}
              >
                Mã NV<SortIcon field="employee_code" />
              </th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("full_name")}
              >
                Tên nhân viên<SortIcon field="full_name" />
              </th>
              <th className="hidden px-3 py-2 font-medium md:table-cell">Email</th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("department")}
              >
                Phòng ban<SortIcon field="department" />
              </th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Chức vụ</th>
              <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">Team</th>
              <th className="hidden whitespace-nowrap px-3 py-2 font-medium lg:table-cell">Giới tính</th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("contract_type")}
              >
                Loại HĐ<SortIcon field="contract_type" />
              </th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("signed_date")}
              >
                Ngày ký<SortIcon field="signed_date" />
              </th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("end_date")}
              >
                Ngày kết thúc<SortIcon field="end_date" />
              </th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("days_remaining")}
              >
                Còn lại<SortIcon field="days_remaining" />
              </th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">Tình trạng</th>
              <th
                className="cursor-pointer whitespace-nowrap px-3 py-2 font-medium select-none hover:text-foreground"
                onClick={() => handleSort("status")}
              >
                Trạng thái HĐ<SortIcon field="status" />
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <ShellTableEmptyRow colSpan={15}>
                <Loader2 className="mx-auto size-5 animate-spin" />
              </ShellTableEmptyRow>
            ) : rows.length === 0 ? (
              <ShellTableEmptyRow colSpan={15}>
                Không có nhân viên nào.
              </ShellTableEmptyRow>
            ) : (
              rows.map((c) => {
                const meta = STATUS_META[c.status]
                const remain = daysRemainingDisplay(c)
                const noContract = c.status === "no_contract"
                const existing = asExisting(c)
                return (
                  <tr
                    key={c.employee.id}
                    onClick={() => selectRow(c.employee.id)}
                    className={cn("cursor-pointer border-b transition-colors hover:bg-muted/20", rowHighlightClass(c.employee.id))}
                  >
                    <td className="px-3 py-2">
                      <EmployeeAvatar name={c.employee.full_name} avatarUrl={c.employee.avatar_url} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{c.employee.employee_code}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-medium">{c.employee.full_name ?? c.employee.email ?? "—"}</td>
                    <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">
                      <div className="max-w-[220px] truncate">{c.employee.email ?? "—"}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{c.employee.department ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{c.employee.job_title_name ?? c.employee.position ?? "—"}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2 md:table-cell">
                      {c.employee.team_lead_name ? (
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${teamColorClass(c.employee.team_lead_id)}`}>
                          {c.employee.team_lead_name}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 lg:table-cell">{genderLabel(c.employee.gender)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{contractTypeLabel(c.contract_type)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{c.signed_date ? formatDate(c.signed_date) : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {noContract ? "—" : c.end_date ? formatDate(c.end_date) : "Không thời hạn"}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 ${remain.cls}`}>{remain.text}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Badge
                        className={
                          c.employee.employment_status === "resigned"
                            ? "bg-slate-200 text-slate-700"
                            : "bg-emerald-100 text-emerald-800"
                        }
                      >
                        {c.employee.employment_status === "resigned" ? "Đã thôi việc" : "Đang làm việc"}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Badge className={meta.cls}>{meta.label}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {existing ? (
                          <>
                            <Button size="icon" variant="ghost" title="Xem chi tiết" onClick={() => setDetailContract(existing)}>
                              <Eye className="size-4" />
                            </Button>
                            {existing.file_url && (
                              <ViewFileButton contractId={existing.id} />
                            )}
                            {canWrite && (
                              <Button size="icon" variant="ghost" title="Cập nhật" onClick={() => setEditContract(existing)}>
                                <Pencil className="size-4" />
                              </Button>
                            )}
                            {canDelete && (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Xoá"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setDeleteTarget(existing)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            )}
                          </>
                        ) : canWrite ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            onClick={() => setAddForEmployee(c.employee)}
                          >
                            <Plus className="size-3.5" /> Thêm hợp đồng
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
        )

        const mobileCards = isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto size-5 animate-spin" />
          </p>
        ) : rows.length === 0 ? (
          <ShellEmptyState icon={FileText} description="Không có nhân viên nào." />
        ) : (
          <div className="space-y-3">
            {rows.map((c) => {
              const meta = STATUS_META[c.status]
              const remain = daysRemainingDisplay(c)
              const noContract = c.status === "no_contract"
              const existing = asExisting(c)
              return (
                <ShellListCard
                  key={c.employee.id}
                  onClick={() => selectRow(c.employee.id)}
                  className={rowHighlightClass(c.employee.id)}
                >
                  <div className="flex items-center gap-2">
                    <EmployeeAvatar name={c.employee.full_name} avatarUrl={c.employee.avatar_url} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {c.employee.full_name ?? c.employee.email ?? "—"}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {c.employee.employee_code}
                      </p>
                    </div>
                    <Badge className={meta.cls}>{meta.label}</Badge>
                  </div>
                  <ShellListCardRow label="Phòng ban / Chức vụ" value={`${c.employee.department ?? "—"} / ${c.employee.job_title_name ?? c.employee.position ?? "—"}`} />
                  <ShellListCardRow label="Loại HĐ" value={contractTypeLabel(c.contract_type)} />
                  <ShellListCardRow label="Ngày ký" value={c.signed_date ? formatDate(c.signed_date) : "—"} />
                  <ShellListCardRow
                    label="Ngày kết thúc"
                    value={noContract ? "—" : c.end_date ? formatDate(c.end_date) : "Không thời hạn"}
                  />
                  <ShellListCardRow label="Còn lại" value={<span className={remain.cls}>{remain.text}</span>} />
                  <ShellListCardRow
                    label="Tình trạng"
                    value={
                      <Badge
                        className={
                          c.employee.employment_status === "resigned"
                            ? "bg-slate-200 text-slate-700"
                            : "bg-emerald-100 text-emerald-800"
                        }
                      >
                        {c.employee.employment_status === "resigned" ? "Đã thôi việc" : "Đang làm việc"}
                      </Badge>
                    }
                  />
                  <div
                    className="flex items-center justify-end gap-1 pt-1"
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    {existing ? (
                      <>
                        <Button size="icon" variant="ghost" title="Xem chi tiết" onClick={() => setDetailContract(existing)}>
                          <Eye className="size-4" />
                        </Button>
                        {existing.file_url && <ViewFileButton contractId={existing.id} />}
                        {(canWrite || canDelete) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button size="icon" variant="ghost" aria-label="Thao tác khác">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end">
                              {canWrite && (
                                <DropdownMenuItem onClick={() => setEditContract(existing)}>
                                  <Pencil className="size-4" /> Cập nhật
                                </DropdownMenuItem>
                              )}
                              {canDelete && (
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => setDeleteTarget(existing)}
                                >
                                  <Trash2 className="size-4" /> Xoá
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </>
                    ) : canWrite ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => setAddForEmployee(c.employee)}
                      >
                        <Plus className="size-3.5" /> Thêm hợp đồng
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                </ShellListCard>
              )
            })}
          </div>
        )

        return (
          <>
            <ShellResponsiveList table={desktopTable} cards={mobileCards} />

            {/* Pagination */}
            {total > 0 && (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Hiển thị {fromRow}–{toRow} trên tổng {total} nhân viên
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="max-sm:min-h-11"
                    disabled={safePage <= 1 || isFetching}
                    onClick={() => setPage(safePage - 1)}
                  >
                    <ChevronLeft className="mr-1 size-4" />
                    Trước
                  </Button>
                  <span className="px-2 tabular-nums">
                    Trang {safePage}/{Math.max(totalPages, 1)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="max-sm:min-h-11"
                    disabled={safePage >= totalPages || isFetching}
                    onClick={() => setPage(safePage + 1)}
                  >
                    Sau
                    <ChevronRight className="ml-1 size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )
      })()}

        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <ContractTemplatesTab canWrite={canWrite} />
        </TabsContent>
      </Tabs>

      {(addOpen || addForEmployee) && (
        <AddContractDialog initialEmployee={addForEmployee ?? undefined} onClose={closeAdd} />
      )}
      {editContract && <EditContractDialog contract={editContract} onClose={() => setEditContract(null)} />}
      {detailContract && <DetailContractDialog contract={detailContract} onClose={() => setDetailContract(null)} />}
      {deleteTarget && canDelete && (
        <DeleteContractDialog contract={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
      <ContractStatsDialog open={statsOpen} onOpenChange={setStatsOpen} />
    </div>
  )
}

// ─── Add dialog ──────────────────────────────────────────────────────────────

// Component con: mount sau khi biết contractId → gọi hook upload + callback
// Pattern tách component để gọi hook với id dynamic (hook KHÔNG conditional)
function UploadAfterCreate({
  contractId,
  file,
  onDone,
}: {
  contractId: number
  file: File
  onDone: () => void
}) {
  const uploadFile = useUploadContractFile(contractId)
  const firedRef = useRef(false)
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    uploadFile.mutate(file, {
      onSuccess: () => {
        toast.success("Đã thêm hợp đồng và tải file")
        onDone()
      },
      onError: () => {
        toast.warning("Đã thêm hợp đồng nhưng không thể tải file")
        onDone()
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function AddContractDialog({
  initialEmployee,
  onClose,
}: {
  initialEmployee?: PickedEmployee
  onClose: () => void
}) {
  const create = useCreateContract()
  const [employee, setEmployee] = useState<PickedEmployee | null>(initialEmployee ?? null)
  const [empQuery, setEmpQuery] = useState("")
  const [comboOpen, setComboOpen] = useState(false)
  const { data: empData } = useEmployees({ search: empQuery || undefined, page: 1 })

  const [contractType, setContractType] = useState(DEFAULT_CONTRACT_TYPE)
  const [signedDate, setSignedDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [notes, setNotes] = useState("")
  // File hợp đồng đính kèm (upload sau khi tạo thành công)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  // Sau create OK: lưu contractId để UploadAfterCreate mount + gọi hook
  const [createdContractId, setCreatedContractId] = useState<number | null>(null)

  const employees: Employee[] = empData?.data ?? []

  const submit = () => {
    if (!employee) return toast.error("Vui lòng chọn nhân viên")
    const signedIso = vnDateToIso(signedDate)
    if (!signedIso) return toast.error("Ngày ký không hợp lệ (DD/MM/YYYY)")
    if (endDate && !vnDateToIso(endDate)) return toast.error("Ngày kết thúc không hợp lệ (DD/MM/YYYY)")
    create.mutate(
      {
        employee_id: employee.id,
        contract_type: contractType,
        signed_date: signedIso,
        end_date: endDate ? vnDateToIso(endDate) : null,
        notes: notes.trim() || null,
      },
      {
        onSuccess: (data) => {
          // Upload file sau khi tạo — guard id != null (Contract.id nullable)
          if (pendingFile && data.id != null) {
            // Mount UploadAfterCreate với id thật → hook upload + đóng dialog
            setCreatedContractId(data.id)
          } else {
            toast.success("Đã thêm hợp đồng")
            onClose()
          }
        },
        onError: () => toast.error("Không thể thêm hợp đồng"),
      },
    )
  }

  return (
    <>
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Thêm hợp đồng</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* Employee picker (combobox) */}
          <div className="space-y-1">
            <Label>Nhân viên *</Label>
            {employee ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                <div className="text-sm">
                  <div className="font-medium">{employee.full_name ?? employee.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {employee.employee_code} · {employee.job_title_name ?? employee.position ?? "—"}
                    {employee.department ? ` · ${employee.department}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEmployee(null)}>
                  Đổi
                </Button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  placeholder="Gõ tên hoặc mã nhân viên…"
                  value={empQuery}
                  onChange={(e) => {
                    setEmpQuery(e.target.value)
                    setComboOpen(true)
                  }}
                  onFocus={() => setComboOpen(true)}
                  onBlur={() => setTimeout(() => setComboOpen(false), 200)}
                />
                {comboOpen && employees.length > 0 && (
                  <div
                    role="listbox"
                    className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border bg-popover shadow-md"
                  >
                    {employees.map((emp) => (
                      <button
                        key={emp.id}
                        type="button"
                        className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted"
                        onMouseDown={() => {
                          setEmployee(emp)
                          setComboOpen(false)
                        }}
                      >
                        <span className="font-medium">{emp.full_name ?? emp.email}</span>
                        <span className="text-xs text-muted-foreground">
                          {emp.employee_code} · {emp.job_title_name ?? emp.position ?? "—"}
                          {emp.department ? ` · ${emp.department}` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <ContractFormFields
            contractType={contractType}
            setContractType={setContractType}
            signedDate={signedDate}
            setSignedDate={setSignedDate}
            endDate={endDate}
            setEndDate={setEndDate}
            notes={notes}
            setNotes={setNotes}
          />

          {/* Khu file hợp đồng */}
          <ContractFilePicker file={pendingFile} onFileChange={setPendingFile} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={create.isPending} className="gap-2">
            {create.isPending && <Loader2 className="size-4 animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Upload file sau create — component con để gọi hook với id dynamic */}
    {createdContractId != null && pendingFile && (
      <UploadAfterCreate
        contractId={createdContractId}
        file={pendingFile}
        onDone={onClose}
      />
    )}
  </>
  )
}

// ─── Edit dialog ─────────────────────────────────────────────────────────────

function EditContractDialog({ contract, onClose }: { contract: ExistingContract; onClose: () => void }) {
  const update = useUpdateContract(contract.id)
  const uploadFile = useUploadContractFile(contract.id)
  const deleteFile = useDeleteContractFile(contract.id)
  const [deleteFileOpen, setDeleteFileOpen] = useState(false)
  const viewFile = useViewContractFile()

  const [contractType, setContractType] = useState(contract.contract_type)
  const [signedDate, setSignedDate] = useState(isoToVnDate(contract.signed_date))
  const [endDate, setEndDate] = useState(contract.end_date ? isoToVnDate(contract.end_date) : "")
  const [notes, setNotes] = useState(contract.notes ?? "")
  const [isTerminated, setIsTerminated] = useState(contract.is_terminated)
  // File chọn mới (upload thay thế file cũ)
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  const submit = () => {
    const signedIso = vnDateToIso(signedDate)
    if (!signedIso) return toast.error("Ngày ký không hợp lệ (DD/MM/YYYY)")
    if (endDate && !vnDateToIso(endDate)) return toast.error("Ngày kết thúc không hợp lệ (DD/MM/YYYY)")
    update.mutate(
      {
        contract_type: contractType,
        signed_date: signedIso,
        end_date: endDate ? vnDateToIso(endDate) : null,
        notes: notes.trim() || null,
        is_terminated: isTerminated,
      },
      {
        onSuccess: async () => {
          // Upload file mới (nếu có) rồi mới đóng dialog: callback của mutate() không chạy khi dialog đã unmount
          if (pendingFile) {
            try {
              await uploadFile.mutateAsync(pendingFile)
              toast.success("Đã cập nhật hợp đồng và tải file")
            } catch {
              toast.warning("Đã cập nhật thông tin nhưng không thể tải file")
            }
          } else {
            toast.success("Đã cập nhật hợp đồng")
          }
          onClose()
        },
        onError: () => toast.error("Không thể cập nhật hợp đồng"),
      },
    )
  }

  const handleDeleteFile = () => {
    deleteFile.mutate(undefined, {
      onSuccess: () => {
        toast.success("Đã xoá file")
        setDeleteFileOpen(false)
      },
      onError: () => toast.error("Không thể xoá file"),
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cập nhật hợp đồng — {contract.employee.full_name ?? contract.employee.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ContractFormFields
            contractType={contractType}
            setContractType={setContractType}
            signedDate={signedDate}
            setSignedDate={setSignedDate}
            endDate={endDate}
            setEndDate={setEndDate}
            notes={notes}
            setNotes={setNotes}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isTerminated}
              onChange={(e) => setIsTerminated(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Đã chấm dứt hợp đồng trước hạn
          </label>

          {/* File hợp đồng đính kèm */}
          {contract.file_url ? (
            <div className="space-y-2">
              <Label>File hợp đồng</Label>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-sm text-muted-foreground">Đã có file đính kèm</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-xs"
                  disabled={viewFile.isPending}
                  onClick={() => viewFile.mutate({ id: contract.id, win: window.open("", "_blank") })}
                >
                  {viewFile.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
                  Xem
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1 text-xs text-destructive hover:text-destructive"
                  disabled={deleteFile.isPending}
                  onClick={() => setDeleteFileOpen(true)}
                >
                  {deleteFile.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                  Xoá file
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Tải file mới sẽ thay thế file hiện tại.</p>
              <ContractFilePicker file={pendingFile} onFileChange={setPendingFile} />
            </div>
          ) : (
            <ContractFilePicker file={pendingFile} onFileChange={setPendingFile} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={update.isPending} className="gap-2">
            {update.isPending && <Loader2 className="size-4 animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={deleteFileOpen}
          onOpenChange={setDeleteFileOpen}
          title="Xoá file hợp đồng"
          description="Xoá file hợp đồng đính kèm?"
          confirmLabel="Xoá file"
          pending={deleteFile.isPending}
          onConfirm={handleDeleteFile}
        />
      </DialogContent>
    </Dialog>
  )
}

// ─── File picker component ────────────────────────────────────────────────────

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"])
const MAX_FILE_BYTES = 20 * 1024 * 1024 // 20 MB

function ContractFilePicker({
  file,
  onFileChange,
}: {
  file: File | null
  onFileChange: (f: File | null) => void
}) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null
    if (!picked) return
    if (!ALLOWED_MIME.has(picked.type)) {
      toast.error("Chỉ chấp nhận file PDF, JPG, PNG, WEBP")
      e.target.value = ""
      return
    }
    if (picked.size > MAX_FILE_BYTES) {
      toast.error("File tối đa 20 MB")
      e.target.value = ""
      return
    }
    onFileChange(picked)
  }

  return (
    <div className="space-y-1">
      <Label>File hợp đồng (tuỳ chọn)</Label>
      {file ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-sm">{file.name}</span>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-xs"
            type="button"
            onClick={() => onFileChange(null)}
          >
            <X className="size-3.5" /> Bỏ chọn
          </Button>
        </div>
      ) : (
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/20">
          <FileUp className="size-4 shrink-0" />
          <span>Chọn file PDF / JPG / PNG / WEBP (tối đa 20 MB)</span>
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            className="hidden"
            onChange={handleChange}
          />
        </label>
      )}
    </div>
  )
}

// ─── View file button (tách ra để tái dùng trong bảng) ───────────────────────

function ViewFileButton({ contractId }: { contractId: number }) {
  const viewFile = useViewContractFile()
  return (
    <Button
      size="icon"
      variant="ghost"
      title="Xem file hợp đồng"
      disabled={viewFile.isPending}
      onClick={() => viewFile.mutate({ id: contractId, win: window.open("", "_blank") })}
    >
      {viewFile.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
    </Button>
  )
}

// ─── Shared form fields ──────────────────────────────────────────────────────

interface FormFieldsProps {
  contractType: string
  setContractType: (v: string) => void
  signedDate: string
  setSignedDate: (v: string) => void
  endDate: string
  setEndDate: (v: string) => void
  notes: string
  setNotes: (v: string) => void
}

function ContractFormFields(p: FormFieldsProps) {
  // Dropdown chỉ hiển thị 4 loại HĐLĐ hiện hành. Nếu đang sửa hồ sơ cũ có slug legacy
  // (không rỗng + không nằm trong 4 loại) → prepend giá trị hiện tại để KHÔNG mất lựa chọn.
  const typeOptions =
    p.contractType && !CONTRACT_TYPE_OPTIONS.includes(p.contractType)
      ? [p.contractType, ...CONTRACT_TYPE_OPTIONS]
      : CONTRACT_TYPE_OPTIONS
  return (
    <>
      <div className="space-y-1">
        <Label>Loại hợp đồng</Label>
        <Select value={p.contractType} onValueChange={(v) => p.setContractType(v ?? DEFAULT_CONTRACT_TYPE)}>
          <SelectTrigger>
            <SelectValue placeholder="Chọn loại hợp đồng">
              {(v) => (typeof v === "string" && v ? CONTRACT_TYPE_LABELS[v] ?? v : null)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((t) => (
              <SelectItem key={t} value={t}>
                {CONTRACT_TYPE_LABELS[t] ?? t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Ngày ký *</Label>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="DD/MM/YYYY"
            value={p.signedDate}
            onChange={(e) => p.setSignedDate(autoMaskVnDate(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label>Ngày kết thúc</Label>
          <Input
            type="text"
            inputMode="numeric"
            placeholder="DD/MM/YYYY (bỏ trống = không thời hạn)"
            value={p.endDate}
            onChange={(e) => p.setEndDate(autoMaskVnDate(e.target.value))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Ghi chú</Label>
        <textarea
          className="min-h-[72px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
          value={p.notes}
          onChange={(e) => p.setNotes(e.target.value)}
          placeholder="Ghi chú thêm (nếu có)"
        />
      </div>
    </>
  )
}

// ─── Detail dialog ───────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  )
}

function DetailContractDialog({ contract, onClose }: { contract: ExistingContract; onClose: () => void }) {
  const meta = STATUS_META[contract.status]
  const remain = daysRemainingDisplay(contract)
  const viewFile = useViewContractFile()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chi tiết hợp đồng</DialogTitle>
        </DialogHeader>
        <div className="space-y-0.5">
          <DetailRow label="Mã nhân viên" value={contract.employee.employee_code} />
          <DetailRow label="Tên nhân viên" value={contract.employee.full_name ?? contract.employee.email ?? "—"} />
          <DetailRow label="Chức vụ" value={contract.employee.job_title_name ?? contract.employee.position ?? "—"} />
          <DetailRow label="Bộ phận" value={contract.employee.department ?? "—"} />
          <DetailRow label="Giới tính" value={genderLabel(contract.employee.gender)} />
          <DetailRow
            label="Tình trạng làm việc"
            value={contract.employee.employment_status === "resigned" ? "Đã thôi việc" : "Đang làm việc"}
          />
          <DetailRow label="Loại hợp đồng" value={contractTypeLabel(contract.contract_type)} />
          <DetailRow label="Ngày ký" value={formatDate(contract.signed_date)} />
          <DetailRow label="Ngày kết thúc" value={contract.end_date ? formatDate(contract.end_date) : "Không thời hạn"} />
          <DetailRow label="Số ngày còn lại" value={<span className={remain.cls}>{remain.text}</span>} />
          <DetailRow label="Trạng thái" value={<Badge className={meta.cls}>{meta.label}</Badge>} />
          {contract.terminated_at && (
            <DetailRow label="Ngày chấm dứt" value={formatDate(contract.terminated_at)} />
          )}
          <DetailRow label="Ghi chú" value={contract.notes || "—"} />
          <DetailRow label="Ngày tạo" value={formatDate(contract.created_at)} />
          <DetailRow label="Cập nhật gần nhất" value={formatDate(contract.updated_at)} />
          <DetailRow
            label="File hợp đồng"
            value={
              contract.file_url ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
                  disabled={viewFile.isPending}
                  onClick={() => viewFile.mutate({ id: contract.id, win: window.open("", "_blank") })}
                >
                  {viewFile.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                  Xem file
                </button>
              ) : (
                "Chưa có file"
              )
            }
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete dialog ───────────────────────────────────────────────────────────

function DeleteContractDialog({ contract, onClose }: { contract: ExistingContract; onClose: () => void }) {
  const del = useDeleteContract(contract.id)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Xoá hợp đồng?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Bạn chắc chắn muốn xoá hợp đồng của{" "}
          <span className="font-medium text-foreground">
            {contract.employee.full_name ?? contract.employee.email}
          </span>
          ? Hành động này không thể hoàn tác.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending}
            className="gap-2"
            onClick={() =>
              del.mutate(undefined, {
                onSuccess: () => {
                  toast.success("Đã xoá hợp đồng")
                  onClose()
                },
                onError: () => toast.error("Không thể xoá hợp đồng"),
              })
            }
          >
            {del.isPending && <Loader2 className="size-4 animate-spin" />}
            Xoá
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cổng quyền cấp trang: thiếu `contracts.view` → Forbidden, không mount nội dung (0 request). */
export default function ContractsPage() {
  return (
    <PermissionGate permission="contracts.view">
      <ContractsPageContent />
    </PermissionGate>
  )
}
