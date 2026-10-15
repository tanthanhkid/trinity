"use client"

import { useMemo, useState } from "react"
import { ArrowUpDown, ArrowUp, ArrowDown, MoreHorizontal, Pencil, Trash2, UserMinus, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { useIsPhone } from "@/hooks/use-is-phone"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectContent,
} from "@/components/ui/select"
import {
  useAllEmployees,
  useDeleteEmployee,
  useLockEmployee,
  type Employee,
} from "@/hooks/use-employees"
import { useJobTitles, type JobTitle } from "@/hooks/use-job-titles"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { jobTitleSeniorityRank } from "@/lib/job-title-rank"
import { useAuthStore } from "@/store/auth"
import { usePermissions } from "@/lib/rbac"
import { formatEmployee } from "@/lib/format"
import { teamColorClass } from "@/lib/team-style"
import { cn } from "@/lib/utils"
import { useRowHighlight } from "@/lib/use-row-highlight"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EditEmployeeDialog } from "../../management/employees/page"

function formatVnd(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—"
  const n = typeof v === "string" ? Number(v) : v
  if (!Number.isFinite(n) || n <= 0) return "—"
  return `${n.toLocaleString("vi-VN")}đ`
}

function statusColor(s: string | null) {
  if (s === "active") return "bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]"
  if (s === "on_leave") return "bg-amber-50 text-amber-700"
  if (s === "resigned") return "bg-rose-50 text-rose-600"
  return "bg-blue-50 text-blue-600"
}

function statusLabel(s: string | null) {
  if (s === "active") return "Đang làm"
  if (s === "on_leave") return "Nghỉ phép"
  if (s === "probation") return "Thử việc"
  if (s === "resigned") return "Đã nghỉ"
  if (s === "unclassified") return "Chưa phân loại"
  return s ?? "—"
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

/** Ô Chức danh — CHỈ HIỂN THỊ (read-only). Đổi chức danh qua Sửa / Quản lý nhân viên.
 * Chỉ hiện TÊN chức danh, KHÔNG kèm mã viết tắt (rank_code). */
function RankCell({ employee }: { employee: Employee }) {
  if (!employee.job_title_name) return <span className="text-muted-foreground">—</span>
  return <span>{employee.job_title_name}</span>
}

// Lương cơ bản / Target chuẩn lấy theo Chức danh (job_title) — dùng cho cả hiển thị
// lẫn sort client-side.
function baseSalaryOf(e: Employee, jtMap: Map<number, JobTitle>): number {
  return Number(jtMap.get(e.job_title_id ?? -1)?.base_salary ?? 0)
}
function targetOf(e: Employee, jtMap: Map<number, JobTitle>): number {
  return Number(jtMap.get(e.job_title_id ?? -1)?.standard_target ?? 0)
}

const PAGE_SIZE = 10

// Header cột bấm để sắp xếp (sort client-side trên TOÀN BỘ nhân viên đã tải).
function SortableHead({
  label,
  field,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string
  field: string
  sortBy: string | undefined
  sortDir: "asc" | "desc"
  onSort: (f: string) => void
}) {
  const active = sortBy === field
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] pointer-coarse:sm:after:-inset-y-3 inline-flex select-none items-center gap-1 align-middle hover:text-foreground"
      >
        {label}
        <Icon className={`size-3 ${active ? "" : "opacity-40"}`} />
      </button>
    </TableHead>
  )
}

/** Nút thao tác mỗi dòng — gate theo quyền + ẩn trên dòng của chính mình. */
function RowActions({
  e,
  canMutate,
  isSelf,
  onEdit,
  onResign,
  onDelete,
  compact = false,
}: {
  e: Employee
  canMutate: boolean
  isSelf: boolean
  onEdit: (e: Employee) => void
  onResign: (e: Employee) => void
  onDelete: (e: Employee) => void
  /** Thẻ điện thoại: "Chỉnh sửa" là icon 44px, "Nghỉ việc" + "Xoá" gom vào menu "⋯" (Xoá cuối, qua ConfirmDialog). */
  compact?: boolean
}) {
  if (!canMutate || isSelf) return <span className="text-muted-foreground">—</span>
  if (compact) {
    return (
      <div className="flex items-center justify-end gap-2" onClick={(ev) => ev.stopPropagation()}>
        <Button size="icon" variant="ghost" aria-label="Chỉnh sửa" onClick={() => onEdit(e)}>
          <Pencil className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Thao tác khác"
            className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "max-sm:size-11")}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="max-sm:min-h-11" onClick={() => onResign(e)}>
              <UserMinus className="size-4" />
              Nghỉ việc
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="max-sm:min-h-11 text-destructive" onClick={() => onDelete(e)}>
              <Trash2 className="size-4" />
              Xoá
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
      <Button size="icon" variant="ghost" title="Chỉnh sửa" onClick={() => onEdit(e)}>
        <Pencil className="size-4" />
      </Button>
      <Button size="icon" variant="ghost" title="Nghỉ việc" onClick={() => onResign(e)}>
        <UserMinus className="size-4 text-muted-foreground" />
      </Button>
      <Button size="icon" variant="ghost" title="Xoá" onClick={() => onDelete(e)}>
        <Trash2 className="size-4 text-destructive" />
      </Button>
    </div>
  )
}

/** Popup xác nhận Xoá mềm (giữ phiếu lương lịch sử). Hook nhận id ổn định (render 1 lần). */
function DeleteConfirm({ e, onClose }: { e: Employee; onClose: () => void }) {
  const del = useDeleteEmployee(e.id)
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="Xoá nhân viên khỏi danh sách?"
      description={`${e.full_name ?? e.email} sẽ bị ẩn khỏi danh sách và không tính vào kỳ lương mới. Toàn bộ phiếu lương đã có vẫn được giữ nguyên.`}
      confirmLabel="Xoá"
      cancelLabel="Huỷ"
      tone="destructive"
      pending={del.isPending}
      onConfirm={() =>
        del.mutate(undefined, {
          onSuccess: () => { toast.success("Đã xoá nhân viên"); onClose() },
          onError: () => toast.error("Không thể xoá nhân viên"),
        })
      }
    />
  )
}

/** Popup xác nhận Nghỉ việc (đánh dấu đã nghỉ + khoá tài khoản) — phá huỷ: khoá tài khoản + loại khỏi kỳ lương. */
function ResignConfirm({ e, onClose }: { e: Employee; onClose: () => void }) {
  const lock = useLockEmployee(e.id)
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => { if (!o) onClose() }}
      title="Đánh dấu nhân viên đã nghỉ việc?"
      description={`${e.full_name ?? e.email} sẽ chuyển sang trạng thái "Đã nghỉ" và bị loại khỏi kỳ lương mới. Phiếu lương đã có vẫn giữ nguyên.`}
      confirmLabel="Nghỉ việc"
      cancelLabel="Huỷ"
      tone="destructive"
      pending={lock.isPending}
      onConfirm={() =>
        lock.mutate(undefined, {
          onSuccess: () => { toast.success("Đã đánh dấu nghỉ việc"); onClose() },
          onError: () => toast.error("Không thể đánh dấu nghỉ việc"),
        })
      }
    />
  )
}

export function PayrollEmployees() {
  const isPhone = useIsPhone()
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<string | undefined>(undefined)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const { selectRow, rowHighlightClass } = useRowHighlight<number>()

  // Bộ lọc: state NHÁP (dropdown) + state ÁP DỤNG (bấm "Lọc" mới đổi) — client-side.
  const [draftDept, setDraftDept] = useState("")
  const [draftTeam, setDraftTeam] = useState("") // team_lead_id dạng string
  const [draftJob, setDraftJob] = useState("") // job_title_id dạng string
  const [appliedDept, setAppliedDept] = useState("")
  const [appliedTeam, setAppliedTeam] = useState("")
  const [appliedJob, setAppliedJob] = useState("")

  // Hành động Sửa / Nghỉ việc / Xoá
  const currentUser = useAuthStore((s) => s.user)
  // Sửa/Nghỉ việc/Xoá nhân viên = `employees.manage` (khớp BE employees.controller).
  const canMutate = usePermissions().can("employees.manage")
  const [editing, setEditing] = useState<Employee | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Employee | null>(null)
  const [confirmResign, setConfirmResign] = useState<Employee | null>(null)

  function handleSort(field: string) {
    if (sortBy === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else {
      setSortBy(field)
      setSortDir("asc")
    }
    setPage(1)
  }

  function applyFilters() {
    setAppliedDept(draftDept)
    setAppliedTeam(draftTeam)
    setAppliedJob(draftJob)
    setPage(1)
  }
  // <640px: bộ lọc nằm trong bảng trượt và ÁP NGAY khi chọn (không có nút "Lọc").
  function pickDept(v: string) {
    setDraftDept(v)
    if (isPhone) { setAppliedDept(v); setPage(1) }
  }
  function pickTeam(v: string) {
    setDraftTeam(v)
    if (isPhone) { setAppliedTeam(v); setPage(1) }
  }
  function pickJob(v: string) {
    setDraftJob(v)
    if (isPhone) { setAppliedJob(v); setPage(1) }
  }
  const activeFilterCount = (appliedDept ? 1 : 0) + (appliedTeam ? 1 : 0) + (appliedJob ? 1 : 0)

  function resetFilters() {
    setDraftDept("")
    setDraftTeam("")
    setDraftJob("")
    setAppliedDept("")
    setAppliedTeam("")
    setAppliedJob("")
    setPage(1)
  }

  const { data, isLoading, isError } = useAllEmployees()
  const { data: jobTitles = [] } = useJobTitles()

  const jtMap = useMemo(() => {
    const m = new Map<number, JobTitle>()
    for (const j of jobTitles) m.set(j.id, j)
    return m
  }, [jobTitles])

  // rankOrder: job_title_id → thứ hạng (index lớn = chức danh CAO hơn). jobTitles đã sắp
  // theo sort_order asc ở BE (NV thấp nhất → GDK cao nhất) → dùng index làm cấp bậc.
  const rankOrder = useMemo(() => {
    const m = new Map<number, number>()
    jobTitles.forEach((j, i) => m.set(j.id, i))
    return m
  }, [jobTitles])

  const allEmployees = useMemo(() => data ?? [], [data])

  // Options cho bộ lọc — dept suy từ dữ liệu; team lấy từ bảng teams (Cài đặt > Team).
  const deptOptions = useMemo(() => {
    const s = new Set<string>()
    for (const e of allEmployees) if (e.department) s.add(e.department)
    return [...s].sort((a, b) => a.localeCompare(b, "vi"))
  }, [allEmployees])
  // Nguồn team dropdown từ bảng teams — luôn đồng bộ khi admin thêm/sửa/xoá team.
  // Value = String(team_lead_id) để khớp với `appliedTeam` filter theo team_lead user id.
  const { data: teamsForFilter = [] } = useTeamsForFilter()

  // Lọc (tìm kiếm + 3 bộ lọc, AND) + sort. Mặc định (chưa bấm cột): cấp bậc trong team.
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    const rows = allEmployees.filter((e) => {
      if (appliedDept && e.department !== appliedDept) return false
      if (appliedTeam && String(e.team_lead_id) !== appliedTeam) return false
      if (appliedJob && String(e.job_title_id) !== appliedJob) return false
      if (!kw) return true
      const name = (e.full_name ?? e.email ?? "").toLowerCase()
      const code = (e.employee_code ?? "").toLowerCase()
      return name.includes(kw) || code.includes(kw)
    })

    if (!sortBy) {
      // Mặc định: nhóm theo team → trưởng nhóm đầu → cấp bậc chức danh THEO TÊN
      // (Trưởng nhóm → Chuyên viên chính → Chuyên viên → Nhân viên) → tên A→Z.
      return [...rows].sort((a, b) => {
        // Người không thuộc team đứng cuối; còn lại xếp theo tên team.
        if (!a.team_name !== !b.team_name) return a.team_name ? -1 : 1
        const tn = (a.team_name ?? "").localeCompare(b.team_name ?? "", "vi")
        if (tn !== 0) return tn
        const la = a.team_lead_id ?? 0
        const lb = b.team_lead_id ?? 0
        if (la !== lb) return la - lb
        const sa = a.user_id === a.team_lead_id ? 0 : 1 // trưởng nhóm đứng đầu nhóm
        const sb = b.user_id === b.team_lead_id ? 0 : 1
        if (sa !== sb) return sa - sb
        // Cấp bậc theo TÊN chức danh thực tế (KHÔNG dùng mã/ký hiệu) — cao → thấp.
        // Fallback `position` (text cũ) khi chưa gán job_title_name.
        const nra = jobTitleSeniorityRank(a.job_title_name ?? a.position)
        const nrb = jobTitleSeniorityRank(b.job_title_name ?? b.position)
        if (nra !== nrb) return nrb - nra
        // Cùng cấp chức danh: tiebreak theo sort_order cấu hình (giữ thứ tự ổn định).
        const rka = rankOrder.get(a.job_title_id ?? -1) ?? -1
        const rkb = rankOrder.get(b.job_title_id ?? -1) ?? -1
        if (rka !== rkb) return rkb - rka // cao → thấp
        return (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? "", "vi")
      })
    }

    const dir = sortDir === "asc" ? 1 : -1
    const val = (e: Employee): string | number => {
      switch (sortBy) {
        case "employee_code": return (e.employee_code ?? "").toLowerCase()
        case "full_name": return (e.full_name ?? e.email ?? "").toLowerCase()
        case "department": return (e.department ?? "").toLowerCase()
        case "team": return (e.team_name ?? "").toLowerCase()
        case "job_title": return (e.job_title_name ?? "").toLowerCase()
        case "status": return e.status ?? ""
        case "base_salary": return baseSalaryOf(e, jtMap)
        case "standard_target": return targetOf(e, jtMap)
        default: return 0
      }
    }
    return [...rows].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      if (typeof av === "number" && typeof bv === "number") return dir * (av - bv)
      return dir * String(av).localeCompare(String(bv), "vi")
    })
  }, [allEmployees, search, appliedDept, appliedTeam, appliedJob, sortBy, sortDir, jtMap, rankOrder])

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const desktopTable = (
    <div className="overflow-x-auto rounded-2xl border shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">Ảnh</TableHead>
            <SortableHead label="Mã NV" field="employee_code" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Nhân viên" field="full_name" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Phòng ban" field="department" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Team" field="team" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Chức danh" field="job_title" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Lương cơ bản" field="base_salary" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Target chuẩn" field="standard_target" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            <SortableHead label="Trạng thái" field="status" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
            {canMutate && <TableHead className="w-32 text-right">Thao tác</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading &&
            Array.from({ length: 6 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: canMutate ? 10 : 9 }).map((__, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {isError && (
            <ShellTableEmptyRow colSpan={canMutate ? 10 : 9} className="text-red-500">
              Không thể tải danh sách nhân viên
            </ShellTableEmptyRow>
          )}
          {!isLoading && !isError && pageRows.length === 0 && (
            <ShellTableEmptyRow colSpan={canMutate ? 10 : 9}>
              Không có nhân viên phù hợp bộ lọc
            </ShellTableEmptyRow>
          )}
          {pageRows.map((e) => {
            const jt = e.job_title_id ? jtMap.get(e.job_title_id) : undefined
            return (
              <TableRow
                key={e.id}
                onClick={() => selectRow(e.id)}
                className={cn("cursor-pointer", rowHighlightClass(e.id))}
              >
                <TableCell>
                  <EmployeeAvatar name={e.full_name} avatarUrl={e.avatar_url} />
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {e.employee_code}
                </TableCell>
                <TableCell
                  className="font-medium"
                  title={e.full_name ?? undefined}
                >
                  {formatEmployee({
                    email: e.email,
                    full_name: e.full_name,
                    id: String(e.id),
                  })}
                </TableCell>
                <TableCell>{e.department ?? "—"}</TableCell>
                <TableCell>
                  {e.team_name ? (
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${teamColorClass(e.team_lead_id)}`}>
                      {e.team_name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <RankCell employee={e} />
                </TableCell>
                <TableCell className="font-medium">
                  {formatVnd(jt?.base_salary)}
                </TableCell>
                <TableCell>{formatVnd(jt?.standard_target)}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className={statusColor(e.status)}>
                    {statusLabel(e.status)}
                  </Badge>
                </TableCell>
                {canMutate && (
                  <TableCell className="text-right">
                    <RowActions
                      e={e}
                      canMutate={canMutate}
                      isSelf={!!currentUser && e.user_id === currentUser.id}
                      onEdit={setEditing}
                      onResign={setConfirmResign}
                      onDelete={setConfirmDelete}
                    />
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )

  const mobileCards = isLoading ? (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  ) : isError ? (
    <p className="py-8 text-center text-sm text-red-500">Không thể tải danh sách nhân viên</p>
  ) : pageRows.length === 0 ? (
    <ShellEmptyState icon={Users} description="Không có nhân viên phù hợp bộ lọc" />
  ) : (
    <div className="space-y-3">
      {pageRows.map((e) => {
        const jt = e.job_title_id ? jtMap.get(e.job_title_id) : undefined
        return (
          <ShellListCard
            key={e.id}
            onClick={() => selectRow(e.id)}
            className={rowHighlightClass(e.id)}
          >
            <div className="flex items-center gap-2">
              <EmployeeAvatar name={e.full_name} avatarUrl={e.avatar_url} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {formatEmployee({ email: e.email, full_name: e.full_name, id: String(e.id) })}
                </p>
                <p className="font-mono text-xs text-muted-foreground">{e.employee_code}</p>
              </div>
              <Badge variant="secondary" className={statusColor(e.status)}>
                {statusLabel(e.status)}
              </Badge>
            </div>
            <ShellListCardRow label="Phòng ban" value={e.department ?? "—"} />
            <ShellListCardRow
              label="Team"
              value={
                e.team_name ? (
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${teamColorClass(e.team_lead_id)}`}>
                    {e.team_name}
                  </span>
                ) : (
                  "—"
                )
              }
            />
            <ShellListCardRow label="Chức danh" value={<RankCell employee={e} />} />
            <ShellListCardRow label="Lương cơ bản" value={formatVnd(jt?.base_salary)} />
            <ShellListCardRow label="Target chuẩn" value={formatVnd(jt?.standard_target)} />
            {canMutate && !(!!currentUser && e.user_id === currentUser.id) && (
              <div className="flex justify-end pt-1" onClick={(ev) => ev.stopPropagation()}>
                <RowActions
                  compact
                  e={e}
                  canMutate={canMutate}
                  isSelf={!!currentUser && e.user_id === currentUser.id}
                  onEdit={setEditing}
                  onResign={setConfirmResign}
                  onDelete={setConfirmDelete}
                />
              </div>
            )}
          </ShellListCard>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex w-full flex-wrap items-end gap-3">
          <div className="flex w-full flex-col gap-1.5 sm:w-56">
            <span className="px-1 text-xs font-medium text-muted-foreground">Tìm kiếm</span>
            <Input
              placeholder="Tìm theo tên hoặc mã NV..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              className="h-11 w-full rounded-xl"
            />
          </div>
          <MobileFilterSheet activeCount={activeFilterCount} onReset={resetFilters}>
          <div className="flex w-full flex-col gap-1.5 sm:w-44">
            <span className="px-1 text-xs font-medium text-muted-foreground">Phòng ban</span>
            <Select value={draftDept} onValueChange={(v) => pickDept(v ?? "")}>
              <SelectTrigger className="h-11 w-full rounded-xl">
                <SelectValue placeholder="Tất cả phòng ban">
                  {(v) => (typeof v === "string" && v ? v : "Tất cả phòng ban")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Tất cả phòng ban</SelectItem>
                {deptOptions.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-44">
            <span className="px-1 text-xs font-medium text-muted-foreground">Team</span>
            <Select value={draftTeam} onValueChange={(v) => pickTeam(v ?? "")}>
              <SelectTrigger className="h-11 w-full rounded-xl">
                <SelectValue placeholder="Tất cả team">
                  {(v) => {
                    if (typeof v !== "string" || !v) return "Tất cả team"
                    return teamsForFilter.find((t) => String(t.team_lead_id) === v)?.name ?? "Tất cả team"
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Tất cả team</SelectItem>
                {teamsForFilter.map((t) => (
                  <SelectItem key={t.id} value={String(t.team_lead_id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-full flex-col gap-1.5 sm:w-44">
            <span className="px-1 text-xs font-medium text-muted-foreground">Chức danh</span>
            <Select value={draftJob} onValueChange={(v) => pickJob(v ?? "")}>
              <SelectTrigger className="h-11 w-full rounded-xl">
                <SelectValue placeholder="Tất cả chức danh">
                  {(v) => {
                    if (typeof v !== "string" || !v) return "Tất cả chức danh"
                    return jobTitles.find((j) => String(j.id) === v)?.name ?? "Tất cả chức danh"
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Tất cả chức danh</SelectItem>
                {jobTitles.map((j) => (
                  <SelectItem key={j.id} value={String(j.id)}>{j.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex w-full gap-2 sm:w-auto max-sm:hidden">
            <Button className="h-11 flex-1 sm:flex-none" variant="outline" onClick={applyFilters}>Lọc</Button>
            <Button className="h-11 flex-1 sm:flex-none" variant="ghost" onClick={resetFilters}>Đặt lại</Button>
          </div>
          </MobileFilterSheet>
        </div>
        <p className="text-sm text-muted-foreground max-sm:hidden">
          Lương cơ bản + Target lấy theo Chức danh (cấu hình tại Quản lý → Chức danh).
        </p>
      </div>

      <ShellResponsiveList table={desktopTable} cards={mobileCards} />

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Trang {safePage}/{totalPages} · {total} nhân viên
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Trước
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Sau
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <EditEmployeeDialog employee={editing} onClose={() => setEditing(null)} />
      )}
      {confirmDelete && (
        <DeleteConfirm e={confirmDelete} onClose={() => setConfirmDelete(null)} />
      )}
      {confirmResign && (
        <ResignConfirm e={confirmResign} onClose={() => setConfirmResign(null)} />
      )}
    </div>
  )
}
