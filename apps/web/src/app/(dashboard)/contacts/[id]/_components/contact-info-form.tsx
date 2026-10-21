"use client"

import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MentionEditor } from "@/components/refs/mention-editor"
import { MentionText } from "@/components/refs/mention-text"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Loader2, Pencil, X, Check, User } from "lucide-react"
import apiClient from "@/lib/api-client"
import {
  formatPhone, formatBirthday, formatDate, formatDateTime, formatDateTimeVn,
  formatEmployee,
} from "@/lib/format"
import {
  birthdayDisplayToIso,
  birthdayIsoToDisplay,
  formatBirthdayInput,
} from "@/lib/birthday-format"
import { Can, usePermissions } from "@/lib/rbac"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { useSettingsOptions } from "@/hooks/use-settings-options"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"
import { errorMessage } from "@/lib/error-messages"

const GENDERS = [
  { value: "nam", label: "Nam" },
  { value: "nu", label: "Nữ" },
]

// Danh sách field CỐ ĐỊNH của mục "Thông tin khách hàng" (nhãn + thứ tự hiển thị).
const CUSTOMER_FIELDS: ReadonlyArray<{ fieldKey: string; label: string }> = [
  { fieldKey: "phone_2", label: "SĐT phụ" },
  { fieldKey: "birthday", label: "Ngày sinh" },
  { fieldKey: "gender", label: "Giới tính" },
  { fieldKey: "email", label: "Email" },
  { fieldKey: "current_address", label: "Địa chỉ hiện tại" },
  { fieldKey: "job_title", label: "Nghề nghiệp" },
  { fieldKey: "company_name", label: "Công ty" },
]

function labelOfStatic(
  list: Array<{ value: string; label: string }>,
  value: string | null | undefined,
): string | null {
  if (!value) return null
  return list.find((x) => x.value === value)?.label ?? null
}

export interface ContactData {
  id: number
  phone: string
  phone_2?: string | null
  full_name: string | null
  /** URL avatar khách từ Zalo CDN — hiển thị trong header danh bạ (Zalo OA). */
  avatar_url?: string | null
  source_id: number | null
  source_locked?: boolean
  stage_id: number | null
  contact_status_id: number | null
  source?: { id: number; value: string; label: string } | null
  stage_option?: { id: number; value: string; label: string } | null
  contact_status?: { id: number; value: string; label: string } | null
  job_title: string | null
  birthday: string | null
  reminder_at: string | null
  reminder_notes: string | null
  assigned_to: number | null
  team_id: number | null
  created_by_id?: number | null
  creator?: {
    id: number
    full_name: string
    email: string
  } | null
  gender: string | null
  email: string | null
  current_address: string | null
  company_name: string | null
}

interface Props {
  contact: ContactData
  assigneeName: string | null
  assigneeEmail?: string | null
  creatorName?: string | null
  /** thời điểm khởi tạo danh bạ (ISO), hiển thị kèm giờ:phút:giây. */
  createdAt?: string | null
}

interface FormState {
  full_name: string
  stage_id: string
  contact_status_id: string
  /** chỉ nhập được khi contact CHƯA có nguồn và chưa bị khoá. */
  source_id: string
  phone_2: string
  job_title: string
  birthday: string
  reminder_at: string
  reminder_notes: string
  gender: string
  email: string
  current_address: string
  company_name: string
}

/** ISO (UTC, `...Z`) → `YYYY-MM-DDTHH:mm` theo GIỜ ĐỊA PHƯƠNG — cùng chiều với `new Date(local).toISOString()` lúc lưu. */
function formatReminderAt(value: string | null | undefined): string {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toForm(c: ContactData): FormState {
  return {
    full_name: c.full_name ?? "",
    stage_id: c.stage_id ? String(c.stage_id) : "",
    contact_status_id: c.contact_status_id ? String(c.contact_status_id) : "",
    source_id: c.source_id ? String(c.source_id) : "",
    phone_2: c.phone_2 ?? "",
    job_title: c.job_title ?? "",
    birthday: formatBirthday(c.birthday),
    reminder_at: formatReminderAt(c.reminder_at),
    reminder_notes: c.reminder_notes ?? "",
    gender: c.gender ?? "",
    email: c.email ?? "",
    current_address: c.current_address ?? "",
    company_name: c.company_name ?? "",
  }
}

/** Field text editable theo BE DTO — diff với original để chỉ gửi khi đổi. */
const TEXT_DIFF_KEYS = [
  "phone_2",
  "job_title", "reminder_notes",
  "gender", "email",
  "current_address",
  "company_name",
] as const satisfies ReadonlyArray<keyof FormState>

/**
 * Diff form vs original contact — chỉ gửi field đã đổi (mirror lead form).
 * Khi user xoá field (next === ""), gửi `null` để BE persist null xuống DB.
 * Khi field unchanged → bỏ qua (không có key trong payload).
 */
function toPayload(
  form: FormState,
  contact: ContactData,
): Record<string, string | number | null> {
  const p: Record<string, string | number | null> = {}

  // FK options (number ↔ string) — clear không hỗ trợ ở UI (Select không có
  // option "Bỏ chọn"); chỉ gửi khi có giá trị mới.
  const stagePrev = contact.stage_id ?? null
  const stageNext = form.stage_id ? Number(form.stage_id) : null
  if (stageNext !== stagePrev && stageNext !== null) {
    p.stage_id = stageNext
  }
  const statusPrev = contact.contact_status_id ?? null
  const statusNext = form.contact_status_id ? Number(form.contact_status_id) : null
  if (statusNext !== statusPrev && statusNext !== null) {
    p.contact_status_id = statusNext
  }

  // Nguồn: BACKFILL-ONLY. BE (`ContactsService.update`) chỉ chấp nhận
  // `source_id` khi contact đang `source_id == null && !source_locked`, và trả
  // 403 nếu đã khoá. Vì vậy CHỈ gửi khi contact THẬT SỰ chưa có nguồn —
  // không bao giờ gửi giá trị "y như cũ" cho contact đã có nguồn (sẽ 403 oan).
  const sourceNext = form.source_id ? Number(form.source_id) : null
  if (contact.source_id == null && !contact.source_locked && sourceNext !== null) {
    p.source_id = sourceNext
  }

  // Birthday: form `YYYY-MM-DD`, contact may be Date|string|null. Empty → null.
  const bdPrev = formatBirthday(contact.birthday)
  if (form.birthday !== bdPrev) {
    p.birthday = form.birthday ? form.birthday : null
  }

  // reminder_at: form là local-datetime (giờ địa phương), original ISO UTC. Empty → null.
  const reminderPrev = formatReminderAt(contact.reminder_at)
  if (form.reminder_at !== reminderPrev) {
    p.reminder_at = form.reminder_at
      ? new Date(form.reminder_at).toISOString()
      : null
  }

  // Text fields — diff vs original. Empty `""` (user xoá) → gửi `null` để BE
  // persist null. Unchanged → skip.
  for (const key of TEXT_DIFF_KEYS) {
    const next = form[key] ?? ""
    const prev = (contact[key] as string | null | undefined) ?? ""
    if (next !== prev) {
      p[key] = next === "" ? null : next
    }
  }
  return p
}

/**
 * Layout 3 section trong 1 card — tất cả "Thông tin khách hàng" gộp 1 card
 * duy nhất.
 *  - Section 1: Trạng thái (giai đoạn, trạng thái chi tiết)
 *  - Section 2: Thông tin khách hàng — 4 field cố định (full_name, phone,
 *               source, assignee) + danh sách field CỐ ĐỊNH `CUSTOMER_FIELDS`
 *  - Section 3: Nhắc việc
 */
export function ContactInfoForm({
  contact, assigneeName, assigneeEmail, creatorName, createdAt,
}: Props) {
  const assigneeDisplay = formatEmployee({
    email: assigneeEmail ?? null,
    full_name: assigneeName,
  })
  // hiện người tạo cho MỌI người tạo — nhãn chung "Người tạo"
  // (không còn rẽ nhãn theo vai trò người tạo, RBAC quyền + phạm vi).
  const creatorLabel = "Người tạo"
  // Ghi đè họ tên đã có = đặc quyền vai trò hệ thống "Quản trị" (`isAdmin`) —
  // mirror BE `ContactsService.update` (`user.isAdmin`); không có quyền catalog riêng.
  const { isAdmin } = usePermissions()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<FormState>(toForm(contact))
  const queryClient = useQueryClient()

  const { data: stages = [] } = useSettingsOptions("contact_stage")
  const { data: statuses = [] } = useSettingsOptions("contact_detail_status")
  // Chỉ group `contact_source` (nguồn thủ công/nguồn thật).
  const { data: sources = [] } = useSettingsOptions("contact_source")

  // Birthday display state — đồng bộ với lead form (DD/MM/YYYY mask, ISO state).
  const [birthdayDisplay, setBirthdayDisplay] = useState(() =>
    birthdayIsoToDisplay(form.birthday),
  )

  // "Quản trị" ghi đè được họ tên đã có (BE gate bằng `isAdmin`).
  // Người khác: full_name là LOCK sau khi tạo (chỉ backfill khi rỗng qua BE).

  const mutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      await apiClient.patch(`/contacts/${contact.id}`, data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["contact", String(contact.id)],
      })
      queryClient.invalidateQueries({ queryKey: ["contacts"] })
      toast.success("Cập nhật thành công")
      setEditing(false)
    },
    onError: (err) => toast.error(errorMessage(err, "Không thể cập nhật thông tin")),
  })

  const handleSave = () => {
    const basePayload = toPayload(form, contact)
    const payload: Record<string, unknown> = { ...basePayload }

    // "Quản trị" ghi đè họ tên và đổi nguồn đã có/đã khoá (BE xác thực `isAdmin` lần nữa).
    if (isAdmin) {
      const nameNext = form.full_name.trim()
      const namePrev = (contact.full_name ?? "").trim()
      if (nameNext && nameNext !== namePrev) {
        payload.full_name = nameNext
      }
      const sourceNext = form.source_id ? Number(form.source_id) : null
      if (sourceNext !== null && sourceNext !== contact.source_id) {
        payload.source_id = sourceNext
      }
    }
    mutation.mutate(payload)
  }

  // Vào chế độ sửa: nạp lại form từ `contact` MỚI NHẤT (refetch có thể đã đổi stage/status) — nếu không, lưu sẽ đè giá trị cũ lên thay đổi của người khác.
  const handleStartEdit = () => {
    const nextForm = toForm(contact)
    setForm(nextForm)
    setBirthdayDisplay(birthdayIsoToDisplay(nextForm.birthday))
    setEditing(true)
  }

  const handleCancel = () => {
    const nextForm = toForm(contact)
    setForm(nextForm)
    setBirthdayDisplay(birthdayIsoToDisplay(nextForm.birthday))
    setEditing(false)
  }

  const set = (key: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }))

  return (
    <Card className="rounded-[var(--radius)] border border-[var(--border)] shadow-[var(--shadow-card)] ring-0">
      <CardContent className="pt-6">
        {/* Trạng thái */}
        <div>
          <h3 className="mb-4 text-[15px] font-semibold">Trạng thái</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            {editing ? (
              <>
                <Field label="Giai đoạn">
                  <Select
                    value={form.stage_id}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, stage_id: v ?? "" }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn giai đoạn">
                        {(v) => {
                          if (typeof v !== "string" || !v) return null
                          return stages.find((o) => String(o.id) === v)?.label ?? null
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {stages.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Trạng thái chi tiết">
                  <Select
                    value={form.contact_status_id}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, contact_status_id: v ?? "" }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chưa chọn">
                        {(v) => {
                          if (typeof v !== "string" || !v) return null
                          return statuses.find((o) => String(o.id) === v)?.label ?? null
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {statuses.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Info label="Phụ trách" value={assigneeDisplay} />
              </>
            ) : (
              <>
                <Info
                  label="Giai đoạn"
                  value={contact.stage_option?.label ?? null}
                />
                <Info
                  label="Trạng thái chi tiết"
                  value={contact.contact_status?.label ?? null}
                />
                <Info label="Phụ trách" value={assigneeDisplay} />
              </>
            )}
          </div>
        </div>

        <Separator className="my-6" />

        {/* Thông tin khách hàng — danh sách field cố định `CUSTOMER_FIELDS` */}
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-[15px] font-semibold flex items-center gap-2">
              <User className="h-5 w-5" /> Thông tin khách hàng
            </h3>
            <div className="flex items-center gap-2">
              {!editing && (
                <Can perm="contacts.update">
                  <Button
                    size="sm"
                    className="text-sm"
                    onClick={handleStartEdit}
                  >
                    <Pencil className="mr-1 h-4 w-4" /> Chỉnh sửa thông tin
                  </Button>
                </Can>
              )}
              {editing && (
                <div className="flex gap-2 max-sm:hidden">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancel}
                    disabled={mutation.isPending}
                  >
                    <X className="mr-1 h-4 w-4" /> Huỷ
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={mutation.isPending}
                  >
                    {mutation.isPending ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-4 w-4" />
                    )}
                    Lưu thay đổi
                  </Button>
                </div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {editing && isAdmin ? (
              <Field label="Họ tên">
                <Input
                  value={form.full_name}
                  onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                  placeholder="Nguyễn Văn A"
                />
              </Field>
            ) : (
              <Info label="Họ tên" value={contact.full_name} />
            )}
            <Info
              label="SĐT"
              value={formatPhone(contact.phone)}
            />
            {/* Khách chưa xác định được nguồn thì để trống + MỞ cho sale nhập.

                Điều kiện mở khớp ĐÚNG gate ghi của BE (`ContactsService.update`:
                cho ghi `source_id` khi `source_id == null && !source_locked`) —
                hiện ô sửa rộng hơn gate BE là dẫn người dùng tới lỗi 403.
                "Quản trị" đổi được cả nguồn đã có/đã khoá (BE gate `isAdmin`). */}
            {editing && (isAdmin || (!contact.source_locked && !contact.source)) ? (
              <Field label="Nguồn">
                <Select
                  value={form.source_id}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, source_id: v ?? "" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn nguồn khách hàng">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return sources.find((o) => String(o.id) === v)?.label ?? null
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <Info
                label="Nguồn"
                value={contact.source?.label ?? null}
              />
            )}
            <Info label={creatorLabel} value={creatorName} />
            <Info label="Thời gian khởi tạo" value={formatDateTimeVn(createdAt)} />
            {CUSTOMER_FIELDS.map((cfg) => (
              <SystemFieldInput
                key={cfg.fieldKey}
                fieldKey={cfg.fieldKey}
                label={cfg.label}
                placeholder={null}
                editing={editing}
                contact={contact}
                form={form}
                set={set}
                setForm={setForm}
                birthdayDisplay={birthdayDisplay}
                onBirthdayChange={(display, iso) => {
                  setBirthdayDisplay(display)
                  setForm((f) => ({ ...f, birthday: iso }))
                }}
              />
            ))}
          </div>
        </div>

        <Separator className="my-6" />

        {/* Nhắc việc */}
        <div>
          <h3 className="mb-4 text-[15px] font-semibold">
            Nhắc việc
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
            {editing ? (
              <>
                <Field label="Lịch hẹn nhắc">
                  <VnDateTimeInput
                    value={form.reminder_at}
                    onChange={(v) => setForm((f) => ({ ...f, reminder_at: v }))}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Ghi chú nhắc">
                    <MentionEditor
                      value={form.reminder_notes}
                      onChange={(v) => setForm((f) => ({ ...f, reminder_notes: v ?? "" }))}
                      rows={3}
                      placeholder="Gõ @ để gắn thẻ bản ghi khác (vd @KH001)"
                    />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Info
                  label="Lịch hẹn nhắc"
                  value={
                    contact.reminder_at
                      ? formatDateTime(contact.reminder_at)
                      : null
                  }
                />
                <div className="sm:col-span-2">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Ghi chú nhắc</p>
                    <p className="font-medium">{contact.reminder_notes ? <MentionText text={contact.reminder_notes} /> : "-"}</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        {/* điện thoại — Huỷ / Lưu dính đáy (cụm ở header mục bị ẩn <640px)
            để không phải cuộn ngược lên khi form dài. */}
        {editing && (
          <div className="sm:hidden">
            <MobileActionBar>
              <Button variant="ghost" onClick={handleCancel} disabled={mutation.isPending}>
                <X className="mr-1 h-4 w-4" /> Huỷ
              </Button>
              <Button onClick={handleSave} disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-1 h-4 w-4" />
                )}
                Lưu thay đổi
              </Button>
            </MobileActionBar>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Render system field theo field_key (KHÔNG còn nhánh custom field — xem `CUSTOMER_FIELDS`). */
function SystemFieldInput({
  fieldKey, label, placeholder, editing, contact, form, set, setForm,
  birthdayDisplay, onBirthdayChange,
}: {
  fieldKey: string
  label: string
  placeholder: string | null
  editing: boolean
  contact: ContactData
  form: FormState
  set: (key: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  birthdayDisplay: string
  onBirthdayChange: (display: string, iso: string) => void
}) {
  if (!editing) {
    return (
      <Info label={label} value={readSystemDisplay(fieldKey, contact)} />
    )
  }
  switch (fieldKey) {
    case "phone_2":
      return (
        <Field label={label}>
          <Input
            type="tel"
            inputMode="tel"
            value={form.phone_2}
            onChange={set("phone_2")}
            placeholder={placeholder ?? "0900000001"}
          />
        </Field>
      )
    case "birthday":
      return (
        <Field label={label}>
          <Input
            type="text"
            inputMode="numeric"
            autoComplete="bday"
            placeholder={placeholder ?? "ngày/tháng/năm (VD: 15/03/1990)"}
            value={birthdayDisplay}
            onChange={(e) => {
              const formatted = formatBirthdayInput(e.target.value)
              onBirthdayChange(formatted, birthdayDisplayToIso(formatted))
            }}
          />
        </Field>
      )
    case "gender":
      return (
        <Field label={label}>
          <Select
            value={form.gender}
            onValueChange={(v) => setForm((f) => ({ ...f, gender: v ?? "" }))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Chọn">
                {(v) => (typeof v === "string" && v
                  ? GENDERS.find((g) => g.value === v)?.label ?? null
                  : null)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GENDERS.map((g) => (
                <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )
    case "email":
      return (
        <Field label={label}>
          <Input type="email" value={form.email} onChange={set("email")} placeholder={placeholder ?? "email@example.com"} />
        </Field>
      )
    case "current_address":
      return (
        <div className="md:col-span-2">
          <Field label={label}>
            <Input value={form.current_address} onChange={set("current_address")} placeholder={placeholder ?? "123 Example Street, District 1"} />
          </Field>
        </div>
      )
    case "company_name":
      return (
        <Field label={label}>
          <Input value={form.company_name} onChange={set("company_name")} placeholder={placeholder ?? "Công ty ABC"} />
        </Field>
      )
    case "job_title":
      return (
        <Field label={label}>
          <Input value={form.job_title} onChange={set("job_title")} placeholder={placeholder ?? "Nhân viên"} />
        </Field>
      )
    default:
      return null
  }
}

/** Đọc giá trị display cho system field (read-only mode). */
function readSystemDisplay(fieldKey: string, c: ContactData): string | null {
  switch (fieldKey) {
    case "phone_2": return c.phone_2 ?? null
    case "birthday": return c.birthday ? formatDate(c.birthday) : null
    case "gender": return labelOfStatic(GENDERS, c.gender)
    case "email": return c.email
    case "current_address": return c.current_address
    case "company_name": return c.company_name
    case "job_title": return c.job_title
    default: return null
  }
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-medium">{value || "-"}</p>
    </div>
  )
}

function Field({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
