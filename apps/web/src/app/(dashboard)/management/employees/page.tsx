"use client"

/* Ghi chú: 2 dòng `Number(...).toLocaleString("vi-VN")` (ô hiển thị lương
 * đóng BHXH trong form) định dạng SỐ (dấu phân cách nghìn), ổn định cross-browser —
 * khác với định dạng NGÀY lệch theo trình duyệt. */
import { useState, useRef } from "react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import type { Resolver } from "react-hook-form"
import {
  useEmployees,
  useCreateEmployee,
  useUpdateEmployee,
  useLockEmployee,
  useUnlockEmployee,
  EMPLOYEES_PAGE_SIZE,
} from "@/hooks/use-employees"
import type { Employee, CreateEmployeeDto, UpdateEmployeeDto, EmployeesResponse } from "@/hooks/use-employees"
import { useJobTitles } from "@/hooks/use-job-titles"
import { useDepartments } from "@/hooks/use-departments"
import { useOffices, useResetDevice } from "@/hooks/use-attendance"
import { useTeamsForFilter } from "@/hooks/use-teams"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { formatDate, autoMaskVnDate, parseVnDate } from "@/lib/format"
import { Button, buttonVariants } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
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
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"
import apiClient, { sendKeepalive } from "@/lib/api-client"
import { deferWithUndo } from "@/lib/undo"
import { errorMessage } from "@/lib/error-messages"
import { useOffline } from "@/components/offline-banner"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { Loader2, ChevronLeft, ChevronRight, Camera, RotateCcw, UserPlus, BarChart3, Users } from "lucide-react"
import { teamColorClass } from "@/lib/team-style"
import { cn } from "@/lib/utils"
import { useRowHighlight } from "@/lib/use-row-highlight"
import { StageChip } from "@/components/ui/stage-chip"
import { EmployeeDetail, EmployeeListItem, STATUS_LABELS } from "./_components/employee-detail"
import { EmployeeRolesCard } from "./_components/employee-roles"
import { EmployeeWorkEditor } from "./_components/work-editor"

// ─── Constants ─────────────────────────────────────────────────────────────

const GENDER_LABELS: Record<string, string> = {
  M: "Nam",
  F: "Nữ",
}

const EDUCATION_LABELS: Record<string, string> = {
  dai_hoc_tro_len: "Đại học trở lên",
  cao_dang: "Cao đẳng",
  trung_cap: "Trung cấp",
  thpt_12: "THPT (12/12)",
  thcs: "THCS",
  khac: "Khác",
}

const RECRUITMENT_LABELS: Record<string, string> = {
  hr: "HR tuyển",
  internal: "Nội bộ giới thiệu",
}

// Chuyển ngày VN (DD/MM/YYYY) → ISO an toàn cho payload.
// Trả { ok:true, iso:undefined } khi rỗng; { ok:true, iso } khi hợp lệ;
// { ok:false } khi sai định dạng — KHÔNG bao giờ throw (parseVnDate validate trước).
function resolveDateField(vn: string | undefined): { ok: boolean; iso?: string } {
  const parsed = parseVnDate(vn ?? "") // "" rỗng | ISO YYYY-MM-DD | undefined nếu sai
  if (parsed === undefined) return { ok: false }
  if (!parsed) return { ok: true, iso: undefined }
  return { ok: true, iso: new Date(parsed + "T00:00:00+07:00").toISOString() }
}

// Alias giữ backward compat tại call-site cũ (joined_at)
const resolveJoinedAt = resolveDateField

// prefill "Ngày vào làm" cho form chỉnh sửa.
// joined_at lưu VN-midnight (dạng UTC lùi 7 giờ) → bảng danh sách dùng
// formatDate (timezone VN) ra đúng ngày. `.slice(0,10)` sẽ cắt phần
// ngày UTC thô → form hiển thị lệch -1 ngày so với bảng. Dùng formatDate
// (timezone VN) để form KHỚP bảng; round-trip parseVnDate → resolveJoinedAt trả đúng ISO gốc.
function toVnDateInput(iso: string | null | undefined): string {
  if (!iso) return ""
  const v = formatDate(iso) // "DD/MM/YYYY" theo timezone VN; "—" nếu không parse được
  return v === "—" ? "" : v
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const editSchema = z.object({
  full_name: z.string().min(2, "Họ tên tối thiểu 2 ký tự").max(100),
  employee_code: z.string().max(50, "Mã nhân viên tối đa 50 ký tự").optional(),
  position: z.string().optional(),
  job_title_id: z.number().int().optional(),
  insurance_salary: z.number().int().nullable().optional(),
  office_id: z.number().int().optional(),
  phone: z.string().regex(/^(0|\+84)\d{9}$/, "Số điện thoại không hợp lệ").optional().or(z.literal("")),
  department: z.string().optional(),
  gender: z.enum(["M", "F"]).optional(),
  education_level: z.string().optional(),
  recruitment_source: z.string().optional(),
  status: z.string().optional(),
  joined_at: z.string().optional(),
  // Hồ sơ nhân sự cá nhân
  birth_date: z.string().optional(),
  id_card_number: z.string().optional(),
  id_card_issued_date: z.string().optional(),
  id_card_issued_place: z.string().optional(),
  permanent_address: z.string().optional(),
  current_address: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_name: z.string().optional(),
  bank_account_holder: z.string().optional(),
})

type EditFormValues = z.infer<typeof editSchema>

const createSchema = z.object({
  email: z.string().email("Email không hợp lệ"),
  full_name: z.string().min(2, "Họ tên tối thiểu 2 ký tự").max(100),
  password: z.string().min(6, "Mật khẩu tối thiểu 6 ký tự").optional().or(z.literal("")),
  employee_code: z.string().max(50, "Mã nhân viên tối đa 50 ký tự").optional(),
  position: z.string().optional(),
  job_title_id: z.number().int().optional(),
  insurance_salary: z.number().int().nullable().optional(),
  phone: z.string().regex(/^(0|\+84)\d{9}$/, "Số điện thoại không hợp lệ").optional().or(z.literal("")),
  department: z.string().optional(),
  gender: z.enum(["M", "F"]).optional(),
  education_level: z.string().optional(),
  recruitment_source: z.string().optional(),
  status: z.string().optional(),
  joined_at: z.string().optional(),
  // Hồ sơ nhân sự cá nhân
  birth_date: z.string().optional(),
  id_card_number: z.string().optional(),
  id_card_issued_date: z.string().optional(),
  id_card_issued_place: z.string().optional(),
  permanent_address: z.string().optional(),
  current_address: z.string().optional(),
  bank_account_number: z.string().optional(),
  bank_name: z.string().optional(),
  bank_account_holder: z.string().optional(),
})

type CreateFormValues = z.infer<typeof createSchema>

// ─── Helper: Avatar Initials ────────────────────────────────────────────────

// ─── Helper: Avatar Upload ──────────────────────────────────────────────────

// Thu nhỏ ảnh phía client TRƯỚC khi mã hoá base64 → mọi ảnh (kể cả ảnh điện thoại
// nhiều MB) đều upload được, payload nhỏ. BE vẫn resize 200×200 lần nữa. Luôn xuất
// JPEG để khớp regex chấp nhận của BE (data:image/jpeg|png|webp).
async function downscaleImageToJpegDataUrl(
  file: File,
  maxSize = 512,
  quality = 0.85,
): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error("Không đọc được file ảnh"))
    reader.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Không giải mã được ảnh"))
    image.src = rawDataUrl
  })
  let width = img.naturalWidth || img.width
  let height = img.naturalHeight || img.height
  if (!width || !height) return rawDataUrl
  if (width > maxSize || height > maxSize) {
    const scale = Math.min(maxSize / width, maxSize / height)
    width = Math.max(1, Math.round(width * scale))
    height = Math.max(1, Math.round(height * scale))
  }
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) return rawDataUrl
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL("image/jpeg", quality)
}

function AvatarUpload({
  value,
  onChange,
  name,
}: {
  value: string | null
  onChange: (base64: string | null) => void
  name?: string | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // reset để có thể chọn lại cùng file
    if (!file) return
    // Guard ảnh khổng lồ để tránh treo trình duyệt; ảnh thường sẽ tự thu nhỏ bên dưới.
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Ảnh quá lớn (tối đa 25MB).")
      return
    }
    try {
      const dataUrl = await downscaleImageToJpegDataUrl(file)
      onChange(dataUrl)
    } catch {
      toast.error("Không đọc được ảnh — vui lòng chọn ảnh JPG, PNG hoặc WebP hợp lệ.")
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        {value ? (
          <img
            src={value}
            alt={name ?? "avatar"}
            className="h-16 w-16 rounded-full object-cover"
          />
        ) : (
          <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-xl font-medium text-blue-700">
            {name ? name.split(" ").filter(Boolean).slice(-2).map((s) => s[0].toUpperCase()).join("") : "?"}
          </span>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow max-sm:after:absolute max-sm:after:-inset-3"
          title="Thay đổi ảnh đại diện"
        >
          <Camera className="h-3 w-3" />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-sm text-primary underline-offset-2 hover:underline text-left max-sm:min-h-11"
        >
          {value ? "Đổi ảnh đại diện" : "Tải ảnh lên"}
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-muted-foreground hover:text-destructive text-left max-sm:min-h-11"
          >
            Xoá ảnh
          </button>
        )}
        <p className="text-xs text-muted-foreground">JPG, PNG, WebP — ảnh sẽ được tự động thu nhỏ.</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  )
}

// ─── Helper: Status Badge ────────────────────────────────────────────────────

// ─── Edit Employee Dialog ────────────────────────────────────────────────────

export function EditEmployeeDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const updateMutation = useUpdateEmployee(employee.id)
  const offline = useOffline()
  const resetDevice = useResetDevice()
  // Phòng ban cấu hình ở Cài đặt; giữ cả giá trị hiện tại của NV nếu phòng ban đó đã bị gỡ khỏi danh sách.
  const configuredDepartments = useDepartments()
  const departments = employee.department && !configuredDepartments.includes(employee.department)
    ? [...configuredDepartments, employee.department]
    : configuredDepartments
  const { data: offices = [] } = useOffices()
  // Vai trò đổi ở khối «Vai trò» của hồ sơ; team + quản lý trực tiếp ở khay «Sửa công việc»
  // (cùng `users.manage` + chốt chống leo thang quyền phía máy chủ). Vai trò vẫn cấu hình ở Cài đặt → Vai trò.
  const canResetDevice = usePermissions().can("employees.manage")
  const [avatarBase64, setAvatarBase64] = useState<string | null>(employee.avatar_url ?? null)
  const [resetDeviceOpen, setResetDeviceOpen] = useState(false)
  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema) as Resolver<EditFormValues>,
    defaultValues: {
      full_name: employee.full_name ?? "",
      // Để TRỐNG (không prefill) — gửi rỗng = giữ nguyên mã hiện tại, tránh đông cứng
      // mã tự sinh "NV<id>" vào DB khi sửa các field khác. Mã hiện tại hiển thị ở placeholder.
      employee_code: "",
      position: employee.position ?? "",
      job_title_id: employee.job_title_id ?? undefined,
      insurance_salary: employee.insurance_salary ?? undefined,
      office_id: employee.office_id ?? undefined,
      phone: employee.phone ?? "",
      department: employee.department ?? "",
      gender: employee.gender === "M" || employee.gender === "F" ? employee.gender : undefined,
      education_level: employee.education_level ?? undefined,
      recruitment_source: employee.recruitment_source ?? undefined,
      status: employee.status ?? "active",
      // formatDate (timezone VN) KHỚP bảng — KHÔNG .slice(0,10) (UTC thô lệch -1 ngày)
      joined_at: toVnDateInput(employee.joined_at),
      // Hồ sơ nhân sự cá nhân — ngày dùng toVnDateInput; text dùng ?? ""
      birth_date: toVnDateInput(employee.birth_date),
      id_card_number: employee.id_card_number ?? "",
      id_card_issued_date: toVnDateInput(employee.id_card_issued_date),
      id_card_issued_place: employee.id_card_issued_place ?? "",
      permanent_address: employee.permanent_address ?? "",
      current_address: employee.current_address ?? "",
      bank_account_number: employee.bank_account_number ?? "",
      bank_name: employee.bank_name ?? "",
      bank_account_holder: employee.bank_account_holder ?? "",
    },
  })
  const { data: jobTitles = [] } = useJobTitles({ is_active: true })
  const selectedJobTitle = jobTitles.find((j) => j.id === form.watch("job_title_id"))
  async function onSubmit(values: EditFormValues) {
    const joined = resolveJoinedAt(values.joined_at)
    if (!joined.ok) {
      toast.error("Ngày vào làm không hợp lệ (định dạng DD/MM/YYYY)")
      return
    }
    const birthDateResolved = resolveDateField(values.birth_date)
    if (!birthDateResolved.ok) {
      toast.error("Ngày sinh không hợp lệ (định dạng DD/MM/YYYY)")
      return
    }
    const idCardIssuedDateResolved = resolveDateField(values.id_card_issued_date)
    if (!idCardIssuedDateResolved.ok) {
      toast.error("Ngày cấp CCCD không hợp lệ (định dạng DD/MM/YYYY)")
      return
    }
    try {
      // Xoá trống một ô tuỳ chọn ⇒ gửi null để BE xoá thật (undefined bị bỏ khỏi JSON nên giá trị cũ còn nguyên).
      const dto: UpdateEmployeeDto = {
        full_name: values.full_name,
        employee_code: values.employee_code?.trim() || undefined, // để trống = giữ nguyên mã (placeholder ở form)
        position: jobTitles.find((j) => j.id === values.job_title_id)?.name || values.position || undefined,
        job_title_id: values.job_title_id,
        insurance_salary: values.insurance_salary ?? null,
        office_id: values.office_id ?? null,
        phone: values.phone || null,
        department: values.department || undefined,
        gender: values.gender || undefined,
        education_level: values.education_level || undefined,
        recruitment_source: values.recruitment_source || undefined,
        status: values.status || undefined,
        joined_at: joined.iso,
        birth_date: birthDateResolved.iso ?? null,
        id_card_number: values.id_card_number?.trim() || null,
        id_card_issued_date: idCardIssuedDateResolved.iso ?? null,
        id_card_issued_place: values.id_card_issued_place?.trim() || null,
        permanent_address: values.permanent_address?.trim() || null,
        current_address: values.current_address?.trim() || null,
        bank_account_number: values.bank_account_number?.trim() || null,
        bank_name: values.bank_name?.trim() || null,
        bank_account_holder: values.bank_account_holder?.trim() || null,
        avatar_url: avatarBase64,
      }
      await updateMutation.mutateAsync(dto)
      toast.success("Đã cập nhật thông tin nhân viên")
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, "Chưa cập nhật được nhân viên"))
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-lg flex flex-col max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Sửa thông tin nhân viên</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 px-1 max-sm:px-0">
          <AvatarUpload
            value={avatarBase64}
            onChange={setAvatarBase64}
            name={form.watch("full_name") || employee.full_name || null}
          />
          <div className="space-y-1">
            <Label htmlFor="edit-full_name">Họ tên *</Label>
            <Input id="edit-full_name" {...form.register("full_name")} placeholder="Nguyễn Văn A" />
            {form.formState.errors.full_name && (
              <p className="text-xs text-red-500">{form.formState.errors.full_name.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-employee_code">Mã nhân viên</Label>
              <Input id="edit-employee_code" {...form.register("employee_code")} placeholder={`Hiện tại: ${employee.employee_code} — để trống để giữ nguyên`} />
              {form.formState.errors.employee_code && (
                <p className="text-xs text-red-500">{form.formState.errors.employee_code.message}</p>
              )}
            </div>
          </div>
          {/* Team / Bộ phận — chỉ hiển thị team hiện tại */}
          <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
            <Label>Team / Bộ phận</Label>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Team hiện tại:</span>
              {employee.team_name ? (
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${teamColorClass(employee.team_lead_id)}`}>
                  {employee.team_name}
                </span>
              ) : (
                <span className="text-muted-foreground">Chưa thuộc team nào</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Team được suy ra từ người quản lý trực tiếp — đổi team và quản lý ở «Sửa công việc»,
              vai trò ở khối «Vai trò» của hồ sơ.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Chức danh</Label>
              <Select
                value={form.watch("job_title_id") ? String(form.watch("job_title_id")) : ""}
                onValueChange={(v) => form.setValue("job_title_id", v ? Number(v) : undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn chức danh">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return jobTitles.find((j) => String(j.id) === v)?.name ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {jobTitles.map((j) => (
                    <SelectItem key={j.id} value={String(j.id)}>{j.name} ({j.symbol})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedJobTitle && (
                <p className="text-xs text-muted-foreground">Cấp bậc: {selectedJobTitle.category} · Ký hiệu: {selectedJobTitle.symbol}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-insurance">Mức lương đóng BHXH (VNĐ)</Label>
              <Input
                id="edit-insurance"
                inputMode="numeric"
                value={
                  form.watch("insurance_salary") != null
                    ? Number(form.watch("insurance_salary")).toLocaleString("vi-VN")
                    : ""
                }
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "")
                  form.setValue("insurance_salary", digits ? Number(digits) : null)
                }}
                placeholder="Để trống = theo Chức vụ / lương cơ bản"
              />
              <p className="text-xs text-muted-foreground">
                Mức lương trích đóng BHXH/BHYT/BHTN (ghi đè mức theo Chức vụ). Để trống = lấy
                theo mức Chức vụ (nếu đã cấu hình), nếu không thì lương cơ bản. Nhập 0 = miễn BHXH
                (thử việc).
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-phone">Số điện thoại</Label>
              <Input id="edit-phone" {...form.register("phone")} placeholder="0900000001" />
              {form.formState.errors.phone && (
                <p className="text-xs text-red-500">{form.formState.errors.phone.message}</p>
              )}
            </div>
          </div>
          {/* Chấm công: văn phòng + thiết bị */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Văn phòng chấm công</Label>
              <Select
                value={form.watch("office_id") ? String(form.watch("office_id")) : ""}
                onValueChange={(v) => form.setValue("office_id", v ? Number(v) : undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chưa gán">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return offices.find((o) => String(o.id) === v)?.name ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Chưa gán</SelectItem>
                  {offices.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Thiết bị đã đăng ký</Label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={employee.registered_device_id ? "Đã đăng ký" : "Chưa đăng ký"}
                  className="bg-muted/40"
                />
                {canResetDevice && employee.registered_device_id && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={resetDevice.isPending}
                    onClick={() => setResetDeviceOpen(true)}
                  >
                    Đặt lại
                  </Button>
                )}
                <ConfirmDialog
                  open={resetDeviceOpen}
                  onOpenChange={setResetDeviceOpen}
                  title="Đặt lại thiết bị"
                  description="Nhân viên sẽ đăng ký lại máy ở lần chấm công kế tiếp."
                  tone="default"
                  confirmLabel="Đặt lại thiết bị"
                  pending={resetDevice.isPending}
                  onConfirm={() =>
                    resetDevice.mutate(employee.user_id, {
                      onSuccess: () => {
                        toast.success("Đã đặt lại thiết bị.")
                        setResetDeviceOpen(false)
                      },
                      onError: (err) => toast.error(errorMessage(err, "Đặt lại thiết bị thất bại.")),
                    })
                  }
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Phòng ban</Label>
              <Select
                value={form.watch("department") ?? ""}
                onValueChange={(v) => form.setValue("department", v ?? undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn phòng ban">
                    {(v) => (typeof v === "string" && v ? v : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Trạng thái</Label>
              <Select
                value={form.watch("status") ?? "active"}
                onValueChange={(v) => form.setValue("status", v ?? undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn trạng thái">
                    {(v) => (typeof v === "string" && v ? (STATUS_LABELS[v] ?? v) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Giới tính</Label>
              <Select
                value={form.watch("gender") ?? ""}
                onValueChange={(v) => form.setValue("gender", v === "M" || v === "F" ? v : undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn giới tính">
                    {(v) => (typeof v === "string" && v ? (GENDER_LABELS[v] ?? null) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="M">Nam</SelectItem>
                  <SelectItem value="F">Nữ</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-joined_at">Ngày vào làm</Label>
              <Input
                id="edit-joined_at"
                type="text"
                inputMode="numeric"
                value={form.watch("joined_at") ?? ""}
                onChange={(e) => form.setValue("joined_at", autoMaskVnDate(e.target.value), { shouldValidate: false })}
                placeholder="DD/MM/YYYY"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Trình độ học vấn</Label>
              <Select
                value={form.watch("education_level") ?? ""}
                onValueChange={(v) => form.setValue("education_level", v || undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn trình độ">
                    {(v) => (typeof v === "string" && v ? (EDUCATION_LABELS[v] ?? v) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EDUCATION_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Nguồn tuyển dụng</Label>
              <Select
                value={form.watch("recruitment_source") ?? ""}
                onValueChange={(v) => form.setValue("recruitment_source", v || undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn nguồn">
                    {(v) => (typeof v === "string" && v ? (RECRUITMENT_LABELS[v] ?? v) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RECRUITMENT_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* ─── Hồ sơ cá nhân ─────────────────────────────────────────── */}
          <p className="text-xs font-semibold text-muted-foreground pt-2">Hồ sơ cá nhân</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-birth_date">Ngày sinh</Label>
              <Input
                id="edit-birth_date"
                type="text"
                inputMode="numeric"
                value={form.watch("birth_date") ?? ""}
                onChange={(e) => form.setValue("birth_date", autoMaskVnDate(e.target.value), { shouldValidate: false })}
                placeholder="DD/MM/YYYY"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-id_card_number">Số CCCD</Label>
              <Input id="edit-id_card_number" {...form.register("id_card_number")} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-id_card_issued_date">Ngày cấp CCCD</Label>
              <Input
                id="edit-id_card_issued_date"
                type="text"
                inputMode="numeric"
                value={form.watch("id_card_issued_date") ?? ""}
                onChange={(e) => form.setValue("id_card_issued_date", autoMaskVnDate(e.target.value), { shouldValidate: false })}
                placeholder="DD/MM/YYYY"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-id_card_issued_place">Nơi cấp CCCD</Label>
              <Input id="edit-id_card_issued_place" {...form.register("id_card_issued_place")} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-permanent_address">Hộ khẩu thường trú</Label>
            <Input id="edit-permanent_address" {...form.register("permanent_address")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-current_address">Chỗ ở hiện tại</Label>
            <Input id="edit-current_address" {...form.register("current_address")} />
          </div>
          {/* ─── Tài khoản ngân hàng ──────────────────────────────────── */}
          <p className="text-xs font-semibold text-muted-foreground pt-2">Tài khoản ngân hàng</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-bank_account_number">Số tài khoản</Label>
              <Input id="edit-bank_account_number" {...form.register("bank_account_number")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-bank_name">Tên ngân hàng</Label>
              <Input id="edit-bank_name" {...form.register("bank_name")} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-bank_account_holder">Tên chủ tài khoản</Label>
            <Input id="edit-bank_account_holder" {...form.register("bank_account_holder")} />
          </div>
          </div>
          <DialogFooter className="shrink-0 pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={updateMutation.isPending}>Huỷ</Button>
            {/* Mất mạng: khoá lưu (dải báo mất mạng đã nói rõ), dữ liệu trong form vẫn giữ nguyên. */}
            <Button type="submit" disabled={updateMutation.isPending || offline}>
              {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Lưu thay đổi
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Add Employee Dialog ────────────────────────────────────────────────────

function AddEmployeeDialog({ onClose }: { onClose: () => void }) {
  const createMutation = useCreateEmployee()
  const offline = useOffline()
  const departments = useDepartments()
  const { data: jobTitles = [] } = useJobTitles({ is_active: true })
  const [avatarBase64, setAvatarBase64] = useState<string | null>(null)

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema) as Resolver<CreateFormValues>,
    defaultValues: {
      email: "",
      full_name: "",
      password: "",
      employee_code: "",
      status: "active",
    },
  })

  async function onSubmit(values: CreateFormValues) {
    const joined = resolveJoinedAt(values.joined_at)
    if (!joined.ok) {
      toast.error("Ngày vào làm không hợp lệ (định dạng DD/MM/YYYY)")
      return
    }
    const birthDateResolved = resolveDateField(values.birth_date)
    if (!birthDateResolved.ok) {
      toast.error("Ngày sinh không hợp lệ (định dạng DD/MM/YYYY)")
      return
    }
    const idCardIssuedDateResolved = resolveDateField(values.id_card_issued_date)
    if (!idCardIssuedDateResolved.ok) {
      toast.error("Ngày cấp CCCD không hợp lệ (định dạng DD/MM/YYYY)")
      return
    }
    const dto: CreateEmployeeDto = {
      email: values.email.trim().toLowerCase(),
      full_name: values.full_name.trim(),
      password: values.password?.trim() || undefined,
      employee_code: values.employee_code?.trim() || undefined,
      position: jobTitles.find((j) => j.id === values.job_title_id)?.name || values.position || undefined,
      job_title_id: values.job_title_id,
      phone: values.phone || undefined,
      department: values.department || undefined,
      gender: values.gender || undefined,
      education_level: values.education_level || undefined,
      recruitment_source: values.recruitment_source || undefined,
      insurance_salary: values.insurance_salary ?? null,
      status: values.status || "active",
      joined_at: joined.iso,
      birth_date: birthDateResolved.iso,
      id_card_number: values.id_card_number?.trim() || undefined,
      id_card_issued_date: idCardIssuedDateResolved.iso,
      id_card_issued_place: values.id_card_issued_place?.trim() || undefined,
      permanent_address: values.permanent_address?.trim() || undefined,
      current_address: values.current_address?.trim() || undefined,
      bank_account_number: values.bank_account_number?.trim() || undefined,
      bank_name: values.bank_name?.trim() || undefined,
      bank_account_holder: values.bank_account_holder?.trim() || undefined,
      avatar_url: avatarBase64,
    }
    try {
      await createMutation.mutateAsync(dto)
      toast.success("Đã thêm nhân viên mới")
      onClose()
    } catch (err) {
      toast.error(errorMessage(err, "Chưa tạo được nhân viên"))
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-lg flex flex-col max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Thêm nhân viên mới</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4 px-1 max-sm:px-0">
          <AvatarUpload value={avatarBase64} onChange={setAvatarBase64} name={form.watch("full_name") || null} />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="add-email">Email đăng nhập *</Label>
              <Input id="add-email" type="email" {...form.register("email")} placeholder="nhanvien@example.com" />
              {form.formState.errors.email && (
                <p className="text-xs text-red-500">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-full_name">Họ tên *</Label>
              <Input id="add-full_name" {...form.register("full_name")} placeholder="Nguyễn Văn A" />
              {form.formState.errors.full_name && (
                <p className="text-xs text-red-500">{form.formState.errors.full_name.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="add-password">Mật khẩu (để trống = tự sinh)</Label>
              <Input id="add-password" type="password" {...form.register("password")} placeholder="••••••••" autoComplete="new-password" />
              {form.formState.errors.password && (
                <p className="text-xs text-red-500">{form.formState.errors.password.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-employee_code">Mã nhân viên</Label>
              <Input id="add-employee_code" {...form.register("employee_code")} placeholder="NV001..." />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Trạng thái</Label>
              <Select
                value={form.watch("status") ?? "active"}
                onValueChange={(v) => form.setValue("status", v ?? undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn trạng thái">
                    {(v) => (typeof v === "string" && v ? (STATUS_LABELS[v] ?? v) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_LABELS)
                    .filter(([val]) => val !== "unclassified")
                    .map(([val, label]) => (
                      <SelectItem key={val} value={val}>{label}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Chức danh</Label>
              <Select
                value={form.watch("job_title_id") ? String(form.watch("job_title_id")) : ""}
                onValueChange={(v) => form.setValue("job_title_id", v ? Number(v) : undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn chức danh">
                    {(v) => {
                      if (typeof v !== "string" || !v) return null
                      return jobTitles.find((j) => String(j.id) === v)?.name ?? null
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {jobTitles.map((j) => (
                    <SelectItem key={j.id} value={String(j.id)}>{j.name} ({j.symbol})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-insurance">Mức lương đóng BHXH (VNĐ)</Label>
              <Input
                id="add-insurance"
                inputMode="numeric"
                value={
                  form.watch("insurance_salary") != null
                    ? Number(form.watch("insurance_salary")).toLocaleString("vi-VN")
                    : ""
                }
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "")
                  form.setValue("insurance_salary", digits ? Number(digits) : null)
                }}
                placeholder="Để trống = theo Chức vụ / lương cơ bản"
              />
              <p className="text-xs text-muted-foreground">
                Để trống = lấy theo mức Chức vụ (nếu đã cấu hình), nếu không thì lương cơ bản. Nhập 0
                = miễn BHXH (thử việc).
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-phone">Số điện thoại</Label>
              <Input id="add-phone" {...form.register("phone")} placeholder="0900000001" />
              {form.formState.errors.phone && (
                <p className="text-xs text-red-500">{form.formState.errors.phone.message}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Phòng ban</Label>
              <Select
                value={form.watch("department") ?? ""}
                onValueChange={(v) => form.setValue("department", v ?? undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn phòng ban">
                    {(v) => (typeof v === "string" && v ? v : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Giới tính</Label>
              <Select
                value={form.watch("gender") ?? ""}
                onValueChange={(v) => form.setValue("gender", v === "M" || v === "F" ? v : undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn giới tính">
                    {(v) => (typeof v === "string" && v ? (GENDER_LABELS[v] ?? null) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="M">Nam</SelectItem>
                  <SelectItem value="F">Nữ</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Trình độ học vấn</Label>
              <Select
                value={form.watch("education_level") ?? ""}
                onValueChange={(v) => form.setValue("education_level", v || undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn trình độ">
                    {(v) => (typeof v === "string" && v ? (EDUCATION_LABELS[v] ?? v) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EDUCATION_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Nguồn tuyển dụng</Label>
              <Select
                value={form.watch("recruitment_source") ?? ""}
                onValueChange={(v) => form.setValue("recruitment_source", v || undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn nguồn">
                    {(v) => (typeof v === "string" && v ? (RECRUITMENT_LABELS[v] ?? v) : null)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RECRUITMENT_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-joined_at">Ngày vào làm</Label>
            <Input
              id="add-joined_at"
              type="text"
              inputMode="numeric"
              value={form.watch("joined_at") ?? ""}
              onChange={(e) => form.setValue("joined_at", autoMaskVnDate(e.target.value), { shouldValidate: false })}
              placeholder="DD/MM/YYYY"
            />
          </div>
          {/* ─── Hồ sơ cá nhân ─────────────────────────────────────────── */}
          <p className="text-xs font-semibold text-muted-foreground pt-2">Hồ sơ cá nhân</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="add-birth_date">Ngày sinh</Label>
              <Input
                id="add-birth_date"
                type="text"
                inputMode="numeric"
                value={form.watch("birth_date") ?? ""}
                onChange={(e) => form.setValue("birth_date", autoMaskVnDate(e.target.value), { shouldValidate: false })}
                placeholder="DD/MM/YYYY"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-id_card_number">Số CCCD</Label>
              <Input id="add-id_card_number" {...form.register("id_card_number")} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="add-id_card_issued_date">Ngày cấp CCCD</Label>
              <Input
                id="add-id_card_issued_date"
                type="text"
                inputMode="numeric"
                value={form.watch("id_card_issued_date") ?? ""}
                onChange={(e) => form.setValue("id_card_issued_date", autoMaskVnDate(e.target.value), { shouldValidate: false })}
                placeholder="DD/MM/YYYY"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-id_card_issued_place">Nơi cấp CCCD</Label>
              <Input id="add-id_card_issued_place" {...form.register("id_card_issued_place")} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-permanent_address">Hộ khẩu thường trú</Label>
            <Input id="add-permanent_address" {...form.register("permanent_address")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-current_address">Chỗ ở hiện tại</Label>
            <Input id="add-current_address" {...form.register("current_address")} />
          </div>
          {/* ─── Tài khoản ngân hàng ──────────────────────────────────── */}
          <p className="text-xs font-semibold text-muted-foreground pt-2">Tài khoản ngân hàng</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="add-bank_account_number">Số tài khoản</Label>
              <Input id="add-bank_account_number" {...form.register("bank_account_number")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-bank_name">Tên ngân hàng</Label>
              <Input id="add-bank_name" {...form.register("bank_name")} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-bank_account_holder">Tên chủ tài khoản</Label>
            <Input id="add-bank_account_holder" {...form.register("bank_account_holder")} />
          </div>
          </div>
          <DialogFooter className="shrink-0 pt-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={createMutation.isPending}>Huỷ</Button>
            <Button type="submit" disabled={createMutation.isPending || offline}>
              {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Thêm nhân viên
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── View Employee Dialog (read-only) ───────────────────────────────────────

// ─── Lock / Delete Confirm Dialogs ──────────────────────────────────────────

function LockConfirmDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const lockMutation = useLockEmployee(employee.id)
  const unlockMutation = useUnlockEmployee(employee.id)
  // Tài khoản đang khoá ⇒ hộp thoại này là "Mở khoá" (nút chỉ hiện cho Quản trị).
  if (employee.user_status === "locked") {
    return (
      <ConfirmDialog
        open
        onOpenChange={(v) => { if (!v) onClose() }}
        title="Mở khoá tài khoản?"
        description={
          <>
            <span className="font-medium text-foreground">{employee.full_name ?? employee.email}</span> sẽ đăng nhập lại được
            và trở về trạng thái đang làm việc (chấm công, lương tính lại từ hôm nay). Người đó cần đăng nhập lại từ đầu.
          </>
        }
        confirmLabel="Mở khoá"
        pending={unlockMutation.isPending}
        onConfirm={async () => {
          try {
            await unlockMutation.mutateAsync()
            toast.success("Đã mở khoá tài khoản nhân viên")
            onClose()
          } catch (err) {
            toast.error(errorMessage(err, "Chưa mở khoá được tài khoản"))
          }
        }}
      />
    )
  }
  return (
    <ConfirmDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      title="Xác nhận khoá tài khoản"
      description={
        <>
          Bạn có chắc muốn khoá tài khoản của{" "}
          <span className="font-medium text-foreground">{employee.full_name ?? employee.email}</span>?
          Nhân viên này sẽ không thể đăng nhập hệ thống.
        </>
      }
      tone="destructive"
      confirmLabel="Khoá nhân viên"
      pending={lockMutation.isPending}
      onConfirm={async () => {
        try {
          await lockMutation.mutateAsync()
          toast.success("Đã khoá tài khoản nhân viên")
          onClose()
        } catch (err) {
          toast.error(errorMessage(err, "Chưa khoá được tài khoản"))
        }
      }}
    />
  )
}

function DeleteConfirmDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const queryClient = useQueryClient()
  return (
    <ConfirmDialog
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      title="Xác nhận xoá nhân viên"
      description={
        <>
          Bạn có chắc muốn xoá hồ sơ nhân viên{" "}
          <span className="font-medium text-foreground">{employee.full_name ?? employee.email}</span>?
          Tài khoản đăng nhập của họ sẽ <span className="font-medium">giữ nguyên</span>. Để khoá đăng nhập, dùng chức năng Khoá tài khoản.
        </>
      }
      tone="destructive"
      confirmLabel="Xoá nhân viên"
      onConfirm={() => {
        onClose()
        // Chưa có API khôi phục hồ sơ nhân viên ⇒ ẩn ngay, chỉ gửi lệnh xoá sau 5 giây; "Hoàn tác" thì không gửi gì.
        queryClient.setQueriesData<EmployeesResponse>({ queryKey: ["employees"] }, (d) =>
          d && Array.isArray(d.data) ? { ...d, data: d.data.filter((e) => e.id !== employee.id) } : d,
        )
        deferWithUndo({
          message: `Đã xoá hồ sơ ${employee.full_name ?? employee.email}`,
          commit: () =>
            apiClient
              .delete(`/management/employees/${employee.id}`)
              .catch((err) => toast.error(errorMessage(err, "Chưa xoá được nhân viên")))
              .finally(() => queryClient.invalidateQueries({ queryKey: ["employees"] })),
          commitOnUnload: () => sendKeepalive("DELETE", `/management/employees/${employee.id}`),
          onUndo: () => queryClient.invalidateQueries({ queryKey: ["employees"] }),
        })
      }}
    />
  )
}

// ─── Thống kê nhân viên ──────────────────────────────────────────────
// Dashboard "Thống kê nhân viên" (Tổng quan + Team + Sinh nhật) đã tách ra trang
// riêng /management/employees/stats — nút "Thống kê" ở header điều hướng sang đó.

const SORT_OPTIONS = [
  { value: "employee_code:asc", label: "Mã NV (A → Z)" },
  { value: "employee_code:desc", label: "Mã NV (Z → A)" },
  { value: "full_name:asc", label: "Họ tên (A → Z)" },
  { value: "full_name:desc", label: "Họ tên (Z → A)" },
  { value: "position:asc", label: "Chức vụ (A → Z)" },
  { value: "position:desc", label: "Chức vụ (Z → A)" },
  { value: "status:asc", label: "Trạng thái (A → Z)" },
  { value: "status:desc", label: "Trạng thái (Z → A)" },
  { value: "joined_at:asc", label: "Ngày vào làm (cũ nhất)" },
  { value: "joined_at:desc", label: "Ngày vào làm (mới nhất)" },
]

// ─── Main Page ───────────────────────────────────────────────────────────────

function EmployeesPageContent() {
  const { can, isAdmin } = usePermissions()
  const departments = useDepartments()
  const canAdd = can("employees.manage")
  const canEdit = can("employees.manage")
  const canLock = can("users.manage")
  const canDelete = can("users.manage")

  const { selectRow, rowHighlightClass } = useRowHighlight<number>()

  // Filters
  const [search, setSearch] = useState("")
  const [department, setDepartment] = useState("")
  const [filterPosition, setFilterPosition] = useState("")
  const [filterStatus, setFilterStatus] = useState("")
  const [filterTeam, setFilterTeam] = useState("")
  // Tình trạng tài khoản — mặc định "active" (ẩn NV đã nghỉ việc khỏi danh sách thường ngày)
  const [employmentState, setEmploymentState] = useState<"active" | "resigned" | "all">("active")
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<string | undefined>(undefined)
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")

  // Nguồn dropdown "Team" — lấy từ bảng teams (Cài đặt > Team), luôn đồng bộ khi thêm/sửa/xoá team.
  // includeUnled:true để hiện cả team chưa gán Người phụ trách nhưng có NV gán trực tiếp;
  // filter gửi lên BE = id team (KHÔNG team_lead_id).
  const { data: teamsForFilter = [] } = useTeamsForFilter({ includeUnled: true })

  const { data, isLoading, isFetching, isError, error, refetch } = useEmployees({
    search: search || undefined,
    department: department || undefined,
    position: filterPosition || undefined,
    status: filterStatus || undefined,
    team: filterTeam || undefined,
    employment_state: employmentState,
    page,
    sort_by: sortBy,
    sort_dir: sortBy ? sortDir : undefined,
  })

  // Chức danh từ Cấu hình chức danh — dùng cho filter "Chức vụ" (thay vì hardcode)
  const { data: jobTitleOptions = [] } = useJobTitles({ is_active: true })

  // Dialog state
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null)
  const [lockTarget, setLockTarget] = useState<Employee | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null)
  const [workTarget, setWorkTarget] = useState<Employee | null>(null)

  const totalPages = data?.pagination.total_pages ?? 1
  const employees = data?.data ?? []
  const total = data?.pagination.total ?? 0
  // Clamp trang hiển thị: nếu refetch nền làm total co lại (vd admin khác xoá NV)
  // mà `page` vẫn trỏ trang cũ vượt totalPages → tránh "Hiển thị 21–5 trên tổng 5".
  const safePage = Math.min(page, totalPages)
  const fromRow = total === 0 ? 0 : (safePage - 1) * EMPLOYEES_PAGE_SIZE + 1
  const toRow = Math.min(safePage * EMPLOYEES_PAGE_SIZE, total)
  // total là số ĐÃ LỌC — phân biệt "kho rỗng" vs "lọc không khớp" phải dựa vào filter đang bật
  const hasActiveFilters = Boolean(
    search || department || filterPosition || filterStatus || filterTeam || employmentState !== "active",
  )

  const resetFilters = () => {
    setSearch(""); setDepartment(""); setFilterPosition(""); setFilterStatus(""); setFilterTeam("")
    setEmploymentState("active"); setPage(1)
  }
  // Số bộ lọc đang bật TRONG bảng lọc điện thoại (ô tìm kiếm nằm ngoài nên không tính)
  const sheetActiveCount = [
    department, filterPosition, filterTeam, sortBy,
    filterStatus || employmentState !== "active" ? "x" : "",
  ].filter(Boolean).length

  const [selectedId, setSelectedId] = useState<number | null>(null)
  // Điện thoại: danh sách và hồ sơ là HAI màn riêng (bố cục khác desktop) — true = đang xem hồ sơ.
  const [mobileDetail, setMobileDetail] = useState(false)
  const [resetDeviceTarget, setResetDeviceTarget] = useState<Employee | null>(null)
  const resetDevice = useResetDevice()
  const canResetDevice = can("employees.manage")

  // Desktop luôn có một hồ sơ đang chọn: giữ cái đã chọn nếu còn trong trang, không thì lấy hàng đầu.
  const selected = employees.find((e) => e.id === selectedId) ?? null
  const current = selected ?? employees[0] ?? null
  // Điện thoại: người đang xem biến khỏi trang (vừa xoá, đổi lọc) ⇒ về danh sách, KHÔNG lặng lẽ mở hồ sơ người khác.
  const showMobileDetail = mobileDetail && selected !== null
  function openEmployee(emp: Employee) {
    selectRow(emp.id)
    setSelectedId(emp.id)
    setMobileDetail(true)
  }

  // Chip trạng thái ngay dưới ô tìm kiếm — gộp "Trạng thái" + "Tình trạng tài khoản" như bộ lọc cũ.
  const statusValue =
    employmentState === "resigned" ? "__resigned__" : employmentState === "all" ? "__all__" : filterStatus || "__active__"
  function pickStatus(v: string) {
    if (v === "__resigned__") { setFilterStatus(""); setEmploymentState("resigned") }
    else if (v === "__all__") { setFilterStatus(""); setEmploymentState("all") }
    else if (v === "__active__") { setFilterStatus(""); setEmploymentState("active") }
    else { setFilterStatus(v); setEmploymentState("active") }
    setPage(1)
  }
  const STATUS_CHIPS: { value: string; label: string }[] = [
    { value: "__active__", label: "Đang làm việc" },
    { value: "probation", label: "Thử việc" },
    { value: "waiting", label: "Chờ vào làm" },
    { value: "on_leave", label: "Tạm nghỉ" },
    { value: "unclassified", label: "Chưa phân loại" },
    { value: "__resigned__", label: "Đã nghỉ việc" },
    { value: "__all__", label: "Tất cả" },
  ]

  return (
    <div className="space-y-4">
      <ShellPageHeader
        title="Nhân viên"
        icon={Users}
        // Điện thoại đang xem hồ sơ: ẩn đầu trang danh sách (kèm nút nổi «Thêm nhân viên») — hồ sơ là màn riêng.
        className={cn(showMobileDetail && "max-lg:hidden")}
        description={total > 0 ? `${total} nhân viên` : hasActiveFilters ? "0 nhân viên" : "Chưa có nhân viên"}
        actions={
          <>
            <Link
              href="/management/employees/stats"
              className={cn(buttonVariants({ variant: "ax-secondary", size: "ax" }), "max-sm:min-h-11")}
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              Thống kê
            </Link>
            {canAdd && (
              <Button
                variant="ax-primary"
                size="ax"
                className={MOBILE_FAB_CLASS}
                onClick={() => setShowAddDialog(true)}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Thêm nhân viên
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-start gap-4 max-lg:block">
        {/* Danh sách — điện thoại: ẩn khi đang xem hồ sơ */}
        <section
          aria-label="Danh sách nhân viên"
          className={cn(
            "w-[380px] shrink-0 overflow-hidden rounded-ax-card border border-ax-line bg-ax-surface shadow-ax-card max-lg:w-full",
            showMobileDetail && "max-lg:hidden",
          )}
        >
          <div className="p-3 pb-2">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor="emp-search" className="sr-only">Tìm nhân viên</Label>
                <Input
                  id="emp-search"
                  variant="ax"
                  placeholder="Tìm tên, mã, email, SĐT"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                />
              </div>
              <MobileFilterSheet activeCount={sheetActiveCount} onReset={resetFilters}>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Phòng ban</Label>
                  <Select
                    value={department || "__all__"}
                    onValueChange={(v) => { setDepartment(v === "__all__" || !v ? "" : v); setPage(1) }}
                  >
                    <SelectTrigger className="w-44 max-sm:w-full">
                      <SelectValue placeholder="Chọn phòng ban">
                        {(v) => (typeof v === "string" && v && v !== "__all__" ? v : "Tất cả phòng ban")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Tất cả phòng ban</SelectItem>
                      {departments.map((d) => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Chức vụ</Label>
                  <Select
                    value={filterPosition || "__all__"}
                    onValueChange={(v) => { setFilterPosition(v === "__all__" || !v ? "" : v); setPage(1) }}
                  >
                    <SelectTrigger className="w-44 max-sm:w-full">
                      <SelectValue placeholder="Chọn chức vụ">
                        {(v) => (typeof v === "string" && v && v !== "__all__" ? v : "Tất cả chức vụ")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Tất cả chức vụ</SelectItem>
                      {jobTitleOptions.map((j) => (
                        <SelectItem key={j.id} value={j.name}>{j.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Team</Label>
                  <Select
                    value={filterTeam || "__all__"}
                    onValueChange={(v) => { setFilterTeam(v === "__all__" || !v ? "" : v); setPage(1) }}
                  >
                    <SelectTrigger className="w-44 max-sm:w-full">
                      <SelectValue placeholder="Chọn team">
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
                        <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Sắp xếp</Label>
                  <Select
                    value={sortBy ? `${sortBy}:${sortDir}` : "__none__"}
                    onValueChange={(v) => {
                      if (!v || v === "__none__") { setSortBy(undefined); setSortDir("asc") }
                      else {
                        const [field, dir] = v.split(":")
                        setSortBy(field)
                        setSortDir(dir === "desc" ? "desc" : "asc")
                      }
                      setPage(1)
                    }}
                  >
                    <SelectTrigger className="w-44 max-sm:w-full">
                      <SelectValue placeholder="Mặc định">
                        {(v) => {
                          if (typeof v !== "string" || v === "__none__") return "Mặc định"
                          return SORT_OPTIONS.find((o) => o.value === v)?.label ?? null
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Mặc định</SelectItem>
                      {SORT_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="ax-secondary"
                  size="ax"
                  className="max-sm:hidden"
                  disabled={!hasActiveFilters}
                  onClick={resetFilters}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Đặt lại
                </Button>
              </MobileFilterSheet>
            </div>
            <div role="group" aria-label="Lọc trạng thái" className="mt-2.5 flex flex-wrap gap-1.5">
              {STATUS_CHIPS.map((c) => (
                <StageChip
                  key={c.value}
                  tone="neutral"
                  selected={statusValue === c.value}
                  onClick={() => pickStatus(c.value)}
                >
                  {c.label}
                </StageChip>
              ))}
            </div>
          </div>

          {/* Khung xương chỉ ở lần tải đầu; tải lại nền (đổi trang/lọc) giữ danh sách cũ, không nhảy bố cục. */}
          {isLoading && <LoadingBlock className="p-4" count={6} label="Đang tải nhân viên…" />}
          {!isLoading && isError && employees.length === 0 && (
            // Lỗi tải ≠ chưa có nhân viên.
            <ErrorState className="m-4" title="Không tải được danh sách nhân viên" error={error} onRetry={() => void refetch()} retrying={isFetching} />
          )}
          {!isLoading && !isError && employees.length === 0 && (
            hasActiveFilters ? (
              <EmptyState variant="ax" className="m-4" title="Không có nhân viên nào phù hợp với bộ lọc" message="Thử bỏ bớt điều kiện lọc hoặc tìm bằng tên, email khác." />
            ) : (
              <EmptyState
                variant="ax"
                className="m-4"
                icon={Users}
                title="Chưa có nhân viên nào"
                message="Thêm nhân viên để giao khách, chấm công và tính lương."
                action={canAdd ? (
                  <Button variant="ax-secondary" size="ax" onClick={() => setShowAddDialog(true)}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    Thêm nhân viên
                  </Button>
                ) : undefined}
              />
            )
          )}
          {employees.map((emp) => (
            <EmployeeListItem
              key={emp.id}
              emp={emp}
              current={current?.id === emp.id}
              onSelect={() => openEmployee(emp)}
              highlightClass={rowHighlightClass(emp.id)}
            />
          ))}

          {total > 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-ax-divider px-3 py-2 text-[13px] text-ax-ink-2">
              <span className="tabular-nums">{fromRow}–{toRow} / {total}</span>
              <div className="flex items-center gap-1">
                <Button
                  size="ax-icon"
                  variant="ax-ghost"
                  aria-label="Trang trước"
                  className="pointer-coarse:size-11"
                  disabled={safePage <= 1 || isFetching}
                  onClick={() => setPage(safePage - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-1 tabular-nums">Trang {safePage}/{totalPages}</span>
                <Button
                  size="ax-icon"
                  variant="ax-ghost"
                  aria-label="Trang sau"
                  className="pointer-coarse:size-11"
                  disabled={safePage >= totalPages || isFetching}
                  onClick={() => setPage(safePage + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </section>
        {/* Điện thoại: chừa chỗ cho nút nổi «Thêm nhân viên» để không đè hàng phân trang/hàng cuối. */}
        {canAdd && !showMobileDetail && <div aria-hidden className="h-20 sm:hidden" />}

        {/* Hồ sơ — điện thoại: màn riêng, mở khi chọn một người */}
        {current && (
          <div className={cn("min-w-0 flex-[1_1_640px]", !showMobileDetail && "max-lg:hidden")}>
            <EmployeeDetail
              emp={current}
              onBack={() => setMobileDetail(false)}
              canEdit={canEdit}
              canLock={canLock}
              canDelete={canDelete}
              isAdmin={isAdmin}
              canResetDevice={canResetDevice}
              onEdit={() => setEditEmployee(current)}
              // Khay «Sửa công việc» gọi PATCH cần `users.manage` (máy chủ) ⇒ thiếu thì nhóm Công việc mở hộp sửa hồ sơ như cũ.
              onEditWork={can("users.manage") ? () => setWorkTarget(current) : undefined}
              renderRoles={(variant) => (
                <EmployeeRolesCard
                  key={current.user_id}
                  userId={current.user_id}
                  name={current.full_name ?? "nhân viên"}
                  canView={can("users.view")}
                  canAssign={can("users.manage")}
                  isAdmin={isAdmin}
                  variant={variant}
                />
              )}
              onLock={() => setLockTarget(current)}
              onDelete={() => setDeleteTarget(current)}
              onResetDevice={() => setResetDeviceTarget(current)}
            />
          </div>
        )}
      </div>

      {/* Dialogs */}
      {showAddDialog && (
        <AddEmployeeDialog onClose={() => setShowAddDialog(false)} />
      )}
      {workTarget && (
        <EmployeeWorkEditor
          key={workTarget.id}
          emp={workTarget}
          canChangeManager={can("users.view")}
          onClose={() => setWorkTarget(null)}
        />
      )}
      {editEmployee && (
        <EditEmployeeDialog
          employee={editEmployee}
          onClose={() => setEditEmployee(null)}
        />
      )}
      <ConfirmDialog
        open={resetDeviceTarget !== null}
        onOpenChange={(v) => { if (!v) setResetDeviceTarget(null) }}
        title="Đặt lại thiết bị"
        description="Nhân viên sẽ đăng ký lại máy ở lần chấm công kế tiếp."
        tone="default"
        confirmLabel="Đặt lại thiết bị"
        pending={resetDevice.isPending}
        onConfirm={() => {
          if (!resetDeviceTarget) return
          resetDevice.mutate(resetDeviceTarget.user_id, {
            onSuccess: () => {
              toast.success("Đã đặt lại thiết bị.")
              setResetDeviceTarget(null)
            },
            onError: (err) => toast.error(errorMessage(err, "Đặt lại thiết bị thất bại.")),
          })
        }}
      />

      {/* Lock / Delete Confirm */}
      {lockTarget && (
        <LockConfirmDialog employee={lockTarget} onClose={() => setLockTarget(null)} />
      )}
      {deleteTarget && (
        <DeleteConfirmDialog employee={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
  )
}

/** Cổng quyền cấp trang: thiếu `employees.view` → Forbidden, không mount nội dung (0 request). */
export default function EmployeesPage() {
  return (
    <PermissionGate permission="employees.view">
      <EmployeesPageContent />
    </PermissionGate>
  )
}
