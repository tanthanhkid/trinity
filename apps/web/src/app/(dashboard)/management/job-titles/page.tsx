"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Award, MoreHorizontal, Plus } from "lucide-react"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard } from "@/components/app-shell/list-card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { formatCurrency } from "@/lib/format"
import {
  useJobTitles,
  useCreateJobTitle,
  useUpdateJobTitle,
  useDeleteJobTitle,
  type JobTitle,
  type CreateJobTitlePayload,
  type UpdateJobTitlePayload,
} from "@/hooks/use-job-titles"

// ─── Constants ────────────────────────────────────────────────────────────────

// Phải khớp với giá trị seed trong migration (seed dùng nhóm cấp bậc)
const CATEGORIES = ["Nhân viên", "Trưởng nhóm", "Trưởng phòng", "Giám đốc khối", "Khác"] as const

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createSchema = z.object({
  category: z.string().min(1, "Vui lòng chọn nhóm"),
  rank_code: z.string().min(1, "Mã cấp bậc không được để trống").max(20),
  name: z.string().min(1, "Tên chức danh không được để trống").max(100),
  symbol: z.string().min(1, "Ký hiệu không được để trống").max(20),
  base_salary: z.number().min(0, "Lương cơ bản không hợp lệ").default(0),
  standard_target: z.number().min(0, "Target không hợp lệ").default(0),
  // mức đóng BHXH cố định theo chức vụ. Ô trống (NaN) → null = dùng lương cơ bản.
  default_insurance_salary: z.preprocess(
    (v) =>
      v === "" || v === undefined || (typeof v === "number" && Number.isNaN(v))
        ? null
        : v,
    z.number().min(0, "Mức đóng BHXH không hợp lệ").nullable(),
  ),
  review_cycle_months: z.number().int().min(1, "Chu kỳ review phải ≥ 1 tháng").max(60),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).default(0),
})

const updateSchema = createSchema.omit({ rank_code: true })

type CreateFormInput = z.input<typeof createSchema>
type CreateFormValues = z.output<typeof createSchema>
type UpdateFormInput = z.input<typeof updateSchema>
type UpdateFormValues = z.output<typeof updateSchema>

// ─── Helper: format số VND ────────────────────────────────────────────────────

function formatVnd(value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") return "—"
  const n = Number(value)
  if (isNaN(n)) return "—"
  return formatCurrency(n)
}

// ─── Page ──────────────────────────────────────────────────────────────────────

function JobTitlesPageContent() {
  const canWrite = usePermissions().can("org.manage")

  const { data: jobTitles = [], isLoading } = useJobTitles()
  const createMutation = useCreateJobTitle()
  const updateMutation = useUpdateJobTitle()
  const deleteMutation = useDeleteJobTitle()

  const [dialogMode, setDialogMode] = useState<"create" | "edit" | null>(null)
  const [editingItem, setEditingItem] = useState<JobTitle | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<JobTitle | null>(null)

  // Sort by sort_order
  const sorted = [...jobTitles].sort((a, b) => a.sort_order - b.sort_order)

  // ─── Create form ────────────────────────────────────────────────────────────

  const createForm = useForm<CreateFormInput, unknown, CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      category: "",
      rank_code: "",
      name: "",
      symbol: "",
      base_salary: 0,
      standard_target: 0,
      default_insurance_salary: null,
      review_cycle_months: 6,
      is_active: true,
      sort_order: 0,
    },
  })

  // ─── Edit form ──────────────────────────────────────────────────────────────

  const editForm = useForm<UpdateFormInput, unknown, UpdateFormValues>({
    resolver: zodResolver(updateSchema),
  })

  function openCreate() {
    createForm.reset()
    setDialogMode("create")
  }

  function openEdit(item: JobTitle) {
    setEditingItem(item)
    editForm.reset({
      category: item.category,
      name: item.name,
      symbol: item.symbol,
      base_salary: Number(item.base_salary),
      standard_target: Number(item.standard_target),
      default_insurance_salary:
        item.default_insurance_salary === null
          ? null
          : Number(item.default_insurance_salary),
      review_cycle_months: item.review_cycle_months,
      is_active: item.is_active,
      sort_order: item.sort_order,
    })
    setDialogMode("edit")
  }

  function closeDialog() {
    setDialogMode(null)
    setEditingItem(null)
  }

  async function onCreateSubmit(values: CreateFormValues) {
    const payload: CreateJobTitlePayload = {
      ...values,
      base_salary: values.base_salary ?? 0,
      standard_target: values.standard_target ?? 0,
    }
    await createMutation.mutateAsync(payload)
    closeDialog()
  }

  async function onEditSubmit(values: UpdateFormValues) {
    if (!editingItem) return
    const payload: UpdateJobTitlePayload = {
      ...values,
      base_salary: values.base_salary ?? 0,
      standard_target: values.standard_target ?? 0,
    }
    await updateMutation.mutateAsync({ id: editingItem.id, payload })
    closeDialog()
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return
    await deleteMutation.mutateAsync(deleteTarget.id)
    setDeleteTarget(null)
  }

  function JobTitleCards() {
    if (isLoading) return <p className="py-8 text-center text-muted-foreground">Đang tải...</p>
    if (sorted.length === 0)
      return <p className="py-8 text-center text-muted-foreground">Chưa có chức danh nào</p>
    return (
      <div className="space-y-3">
        {sorted.map((item) => (
          <ShellListCard key={item.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{item.name}</p>
                <p className="text-xs text-muted-foreground">
                  {item.category} · <span className="font-mono">{item.rank_code}</span> · {item.symbol}
                </p>
              </div>
              <Badge variant={item.is_active ? "default" : "secondary"}>
                {item.is_active ? "Đang dùng" : "Tạm ẩn"}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                Lương CB: {formatVnd(item.base_salary)}
              </span>
              <span className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                BHXH: {item.default_insurance_salary === null ? "Theo lương CB" : formatVnd(item.default_insurance_salary)}
              </span>
              <span className="inline-flex items-center rounded-md border border-pink-200 bg-pink-50 px-2 py-0.5 text-xs font-medium text-pink-600">
                Target: {formatVnd(item.standard_target)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Review mỗi {item.review_cycle_months} tháng</p>
            {canWrite && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => openEdit(item)}>Sửa</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon" aria-label="Thao tác khác" />}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(item)}>
                      Xoá
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </ShellListCard>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <ShellPageHeader
        title="Cấu hình chức danh"
        icon={Award}
        description={<span className="max-sm:hidden">Quản lý bảng chức danh, lương cơ bản và mục tiêu chuẩn theo cấp bậc</span>}
        actions={canWrite && <Button className={MOBILE_FAB_CLASS} onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Thêm chức danh</Button>}
      />

      {/* Table */}
      <ShellResponsiveList
        table={
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nhóm</TableHead>
              <TableHead>Mã cấp bậc</TableHead>
              <TableHead>Tên chức danh</TableHead>
              <TableHead>Ký hiệu</TableHead>
              <TableHead className="text-right font-semibold text-emerald-700">Lương cơ bản</TableHead>
              <TableHead className="text-right font-semibold text-sky-700">Mức đóng BHXH</TableHead>
              <TableHead className="text-right font-semibold text-pink-700">Target chuẩn</TableHead>
              <TableHead>Chu kỳ review</TableHead>
              <TableHead>Trạng thái</TableHead>
              {canWrite && <TableHead className="text-right">Thao tác</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={canWrite ? 10 : 9} className="text-center py-8 text-muted-foreground">
                  Đang tải...
                </TableCell>
              </TableRow>
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canWrite ? 10 : 9} className="text-center py-8 text-muted-foreground">
                  Chưa có chức danh nào
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.category}</TableCell>
                  <TableCell className="font-mono text-sm">{item.rank_code}</TableCell>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell>{item.symbol}</TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                      {formatVnd(item.base_salary)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {item.default_insurance_salary === null ? (
                      <span className="text-muted-foreground">Theo lương CB</span>
                    ) : (
                      <span className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 font-medium text-sky-700">
                        {formatVnd(item.default_insurance_salary)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center rounded-md border border-pink-200 bg-pink-50 px-2 py-0.5 font-medium text-pink-600">
                      {formatVnd(item.standard_target)}
                    </span>
                  </TableCell>
                  <TableCell>{item.review_cycle_months} tháng</TableCell>
                  <TableCell>
                    <Badge variant={item.is_active ? "default" : "secondary"}>
                      {item.is_active ? "Đang dùng" : "Tạm ẩn"}
                    </Badge>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(item)}
                      >
                        Sửa
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(item)}
                      >
                        Xoá
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
        }
        cards={<JobTitleCards />}
      />

      {/* Create Dialog */}
      <Dialog open={dialogMode === "create"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Thêm chức danh mới</DialogTitle>
          </DialogHeader>
          <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4">
            {/* Category */}
            <div className="space-y-1">
              <Label>Nhóm</Label>
              <Select
                value={createForm.watch("category")}
                onValueChange={(v) => createForm.setValue("category", v ?? "", { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn nhóm">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return CATEGORIES.find((c) => c === v) ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {createForm.formState.errors.category && (
                <p className="text-sm text-destructive">{createForm.formState.errors.category.message}</p>
              )}
            </div>

            {/* rank_code */}
            <div className="space-y-1">
              <Label>Mã cấp bậc</Label>
              <Input placeholder="Ví dụ: L1, L2, M1..." {...createForm.register("rank_code")} />
              {createForm.formState.errors.rank_code && (
                <p className="text-sm text-destructive">{createForm.formState.errors.rank_code.message}</p>
              )}
            </div>

            {/* name */}
            <div className="space-y-1">
              <Label>Tên chức danh</Label>
              <Input placeholder="Ví dụ: Nhân viên kinh doanh" {...createForm.register("name")} />
              {createForm.formState.errors.name && (
                <p className="text-sm text-destructive">{createForm.formState.errors.name.message}</p>
              )}
            </div>

            {/* symbol */}
            <div className="space-y-1">
              <Label>Ký hiệu</Label>
              <Input placeholder="Ví dụ: NV-KD" {...createForm.register("symbol")} />
              {createForm.formState.errors.symbol && (
                <p className="text-sm text-destructive">{createForm.formState.errors.symbol.message}</p>
              )}
            </div>

            {/* base_salary + standard_target */}
            <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-4">
              <div className="space-y-1">
                <Label>Lương cơ bản (VND)</Label>
                <Input
                  type="number"
                  min={0}
                  step={100000}
                  placeholder="0"
                  {...createForm.register("base_salary", { valueAsNumber: true })}
                />
                {createForm.formState.errors.base_salary && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.base_salary.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Target chuẩn (VND)</Label>
                <Input
                  type="number"
                  min={0}
                  step={100000}
                  placeholder="0"
                  {...createForm.register("standard_target", { valueAsNumber: true })}
                />
                {createForm.formState.errors.standard_target && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.standard_target.message}</p>
                )}
              </div>
            </div>

            {/* mức đóng BHXH cố định theo chức vụ */}
            <div className="space-y-1">
              <Label>Mức đóng BHXH (VND)</Label>
              <Input
                type="number"
                min={0}
                step={100000}
                placeholder="Bỏ trống = đóng theo lương cơ bản"
                {...createForm.register("default_insurance_salary", { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Mức lương cố định để tính BHXH/BHYT/BHTN (vd 4.500.000). Bỏ trống → đóng theo lương cơ bản. Phần
                chênh lệch so với lương cơ bản hiển thị thành &quot;Phụ cấp xăng xe/ăn ca&quot;.
              </p>
              {createForm.formState.errors.default_insurance_salary && (
                <p className="text-sm text-destructive">
                  {createForm.formState.errors.default_insurance_salary.message}
                </p>
              )}
            </div>

            {/* review_cycle_months + sort_order */}
            <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-4">
              <div className="space-y-1">
                <Label>Chu kỳ review (tháng)</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  {...createForm.register("review_cycle_months", { valueAsNumber: true })}
                />
                {createForm.formState.errors.review_cycle_months && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.review_cycle_months.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Thứ tự hiển thị</Label>
                <Input type="number" min={0} {...createForm.register("sort_order", { valueAsNumber: true })} />
              </div>
            </div>

            {/* is_active */}
            <div className="space-y-1">
              <Label>Trạng thái</Label>
              <Select
                value={String(createForm.watch("is_active"))}
                onValueChange={(v) => createForm.setValue("is_active", (v ?? "true") === "true", { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn trạng thái">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return v === "true" ? "Đang dùng" : "Tạm ẩn"
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Đang dùng</SelectItem>
                  <SelectItem value="false">Tạm ẩn</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog}>Huỷ</Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Đang lưu..." : "Tạo chức danh"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={dialogMode === "edit"} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sửa chức danh</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
              {/* rank_code — disabled when editing */}
              <div className="space-y-1">
                <Label>Mã cấp bậc</Label>
                <Input value={editingItem.rank_code} disabled className="bg-muted" />
                <p className="text-xs text-muted-foreground">Mã cấp bậc không thể thay đổi sau khi tạo</p>
              </div>

              {/* Category */}
              <div className="space-y-1">
                <Label>Nhóm</Label>
                <Select
                  value={editForm.watch("category")}
                  onValueChange={(v) => editForm.setValue("category", v ?? "", { shouldValidate: true })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn nhóm">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return CATEGORIES.find((c) => c === v) ?? null
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editForm.formState.errors.category && (
                  <p className="text-sm text-destructive">{editForm.formState.errors.category.message}</p>
                )}
              </div>

              {/* name */}
              <div className="space-y-1">
                <Label>Tên chức danh</Label>
                <Input {...editForm.register("name")} />
                {editForm.formState.errors.name && (
                  <p className="text-sm text-destructive">{editForm.formState.errors.name.message}</p>
                )}
              </div>

              {/* symbol */}
              <div className="space-y-1">
                <Label>Ký hiệu</Label>
                <Input {...editForm.register("symbol")} />
                {editForm.formState.errors.symbol && (
                  <p className="text-sm text-destructive">{editForm.formState.errors.symbol.message}</p>
                )}
              </div>

              {/* base_salary + standard_target */}
              <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-4">
                <div className="space-y-1">
                  <Label>Lương cơ bản (VND)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={100000}
                    {...editForm.register("base_salary", { valueAsNumber: true })}
                  />
                  {editForm.formState.errors.base_salary && (
                    <p className="text-sm text-destructive">{editForm.formState.errors.base_salary.message}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>Target chuẩn (VND)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={100000}
                    {...editForm.register("standard_target", { valueAsNumber: true })}
                  />
                  {editForm.formState.errors.standard_target && (
                    <p className="text-sm text-destructive">{editForm.formState.errors.standard_target.message}</p>
                  )}
                </div>
              </div>

              {/* mức đóng BHXH cố định theo chức vụ */}
              <div className="space-y-1">
                <Label>Mức đóng BHXH (VND)</Label>
                <Input
                  type="number"
                  min={0}
                  step={100000}
                  placeholder="Bỏ trống = đóng theo lương cơ bản"
                  {...editForm.register("default_insurance_salary", { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground">
                  Mức lương cố định để tính BHXH/BHYT/BHTN. Bỏ trống → đóng theo lương cơ bản. Phần chênh lệch hiển
                  thị thành &quot;Phụ cấp xăng xe/ăn ca&quot; trên phiếu lương.
                </p>
                {editForm.formState.errors.default_insurance_salary && (
                  <p className="text-sm text-destructive">
                    {editForm.formState.errors.default_insurance_salary.message}
                  </p>
                )}
              </div>

              {/* review_cycle_months + sort_order */}
              <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-4">
                <div className="space-y-1">
                  <Label>Chu kỳ review (tháng)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    {...editForm.register("review_cycle_months", { valueAsNumber: true })}
                  />
                  {editForm.formState.errors.review_cycle_months && (
                    <p className="text-sm text-destructive">{editForm.formState.errors.review_cycle_months.message}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label>Thứ tự hiển thị</Label>
                  <Input type="number" min={0} {...editForm.register("sort_order", { valueAsNumber: true })} />
                </div>
              </div>

              {/* is_active */}
              <div className="space-y-1">
                <Label>Trạng thái</Label>
                <Select
                  value={String(editForm.watch("is_active"))}
                  onValueChange={(v) => editForm.setValue("is_active", (v ?? "true") === "true", { shouldValidate: true })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn trạng thái">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return v === "true" ? "Đang dùng" : "Tạm ẩn"
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Đang dùng</SelectItem>
                    <SelectItem value="false">Tạm ẩn</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeDialog}>Huỷ</Button>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? "Đang lưu..." : "Lưu thay đổi"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Xác nhận xoá chức danh"
        description={
          <>
            Bạn có chắc muốn xoá chức danh{" "}
            <span className="font-medium text-foreground">{deleteTarget?.name}</span>{" "}
            ({deleteTarget?.rank_code})? Thao tác này không thể hoàn tác.
          </>
        }
        pending={deleteMutation.isPending}
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

/** Cổng quyền cấp trang: thiếu `org.manage` → Forbidden, không mount nội dung (0 request). */
export default function JobTitlesPage() {
  return (
    <PermissionGate permission="org.manage">
      <JobTitlesPageContent />
    </PermissionGate>
  )
}
