"use client"

// Chi tiết phiếu lương «Ánh xanh» (luong-desktop): đường dẫn trên, trạng thái kỳ, nhóm khoản sửa tại chỗ
// (có Hoàn tác), khối nhấn «Thực nhận» + Lưu/Duyệt ở cột phải. Thay cho hai hộp thoại Sửa phiếu / Chi tiết cũ,
// giữ nguyên API (`PATCH /payslips/:id`, duyệt, xuất, loại khỏi kỳ) và quyền.
import { useId, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, Loader2, Trash2, X } from "lucide-react"
import apiClient from "@/lib/api-client"
import { errorMessage } from "@/lib/error-messages"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AX_INPUT_CLASS } from "@/components/ui/input"
import { HeroCard, HeroCardLabel, HeroCardValue } from "@/components/ui/hero-card"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { showUndoToast } from "@/components/ui/undo-toast"
import {
  type PayslipRow, canApproveNow, canEditPayslip, canRemoveFromPeriod, fmt, formatMonth, statusLabel,
} from "./payroll-payslips-shared"
import {
  type PayslipForm, type PayslipFormKey, changedKeys, digits, formFromRow, n, oneDecimalPoint, payloadFromForm,
  projectTotals, totalsFromForm,
} from "./payroll-payslip-form"

type Kind = "money" | "days" | "num" | "percent"
interface Spec { key: PayslipFormKey; label: string; sub: string; kind: Kind; optional?: boolean }

const BASE_ROWS: Spec[] = [
  { key: "base_salary", label: "Lương cơ bản", sub: "Theo hợp đồng, chưa trừ ngày nghỉ", kind: "money" },
  { key: "working_days", label: "Ngày công thực tế", sub: "Để trống là đủ công (nguyên lương)", kind: "days" },
  { key: "standard_working_days", label: "Ngày công chuẩn", sub: "Mặc định 24 ngày", kind: "days" },
  { key: "training_days", label: "Ngày học việc", sub: "Để trống là không có học việc", kind: "days", optional: true },
  { key: "training_salary", label: "Lương học việc", sub: "Tính vào cộng lương cơ bản", kind: "money", optional: true },
  { key: "probation_allowance", label: "Phụ cấp học việc", sub: "Tính vào cộng lương cơ bản", kind: "money", optional: true },
]
const BONUS_ROWS: Spec[] = [
  { key: "bonus_sales_personal", label: "Thưởng doanh số cá nhân", sub: "Doanh số × hệ số, hoặc nhập tay", kind: "money" },
  { key: "bonus_milestone", label: "Thưởng mốc, vượt mốc", sub: "Điền sẵn là thưởng KPI", kind: "money" },
  { key: "bonus_cskh_team", label: "Thưởng team", sub: "Theo kết quả của team", kind: "money", optional: true },
  { key: "bonus_referral", label: "Thưởng giới thiệu", sub: "Giới thiệu nhân sự hoặc khách mới", kind: "money", optional: true },
  { key: "holiday_bonus", label: "Thưởng lễ", sub: "Lễ, Tết", kind: "money", optional: true },
]
const SALES_ROWS: Spec[] = [
  { key: "sales_personal", label: "Doanh số cá nhân", sub: "Cơ sở tính thưởng doanh số", kind: "money" },
  { key: "bonus_rate", label: "Hệ số thưởng", sub: "Tỷ lệ trên doanh số, ví dụ 0.4 là 0,4%", kind: "percent" },
  { key: "sales_team", label: "Doanh số team", sub: "Chỉ để tham chiếu", kind: "money" },
  { key: "kpi_percent", label: "Tỷ lệ KPI", sub: "Ví dụ 85.5 là 85,5%", kind: "percent" },
]
const ADVANCE_ROW: Spec = { key: "advances", label: "Đã chi lĩnh trước", sub: "Tạm ứng, các khoản chi trước", kind: "money" }

const STEPS = [
  { id: "draft", name: "Nháp" },
  { id: "pending", name: "Chờ duyệt" },
  { id: "approved", name: "Đã duyệt" },
  { id: "paid", name: "Đã trả lương" },
] as const
function stepIndex(status: string): number {
  if (status === "paid") return 3
  if (status === "approved") return 2
  if (status === "pending_tl" || status === "pending_accountant") return 1
  return 0
}

const unitCls = "ml-0.5 text-[0.8em] font-medium text-ax-ink-3"

function display(kind: Kind, v: string): { text: string; unit: string } {
  if (kind === "money") return { text: Number(v || 0).toLocaleString("vi-VN"), unit: "₫" }
  if (v === "") return { text: "—", unit: "" }
  if (kind === "days") return { text: v, unit: " ngày" }
  return { text: v, unit: "%" }
}

function Money({ value, className }: { value: number | string; className?: string }) {
  return (
    <span className={cn("ax-amount", className)}>
      {Number(value).toLocaleString("vi-VN")}
      <span className={unitCls}>₫</span>
    </span>
  )
}

function Group({ title, sum, sumClass, children, footer }: {
  title: string; sum?: React.ReactNode; sumClass?: string; children: React.ReactNode; footer?: React.ReactNode
}) {
  return (
    <section aria-label={title} className="ax-card overflow-hidden">
      <div className="flex items-baseline justify-between px-6 pt-4 pb-2 max-sm:px-4">
        <h2 className="text-[15px] font-bold tracking-[-0.011em]">{title}</h2>
        {sum !== undefined && <span className={cn("text-[15px] font-bold", sumClass)}>{sum}</span>}
      </div>
      {children}
      {footer}
    </section>
  )
}

const rowCls = "flex min-h-14 items-center gap-4 border-t border-ax-divider px-6 py-1.5 max-sm:gap-2 max-sm:px-4"

function ReadRow({ label, sub, value, negative }: { label: string; sub: string; value: number | string; negative?: boolean }) {
  return (
    <div className={rowCls}>
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">{label}</div>
        <div className="mt-px text-[13px] text-ax-ink-2">{sub}</div>
      </div>
      <span className={cn("min-w-[150px] px-3 text-right text-base", negative && "text-ax-ink")}>
        <Money value={value} />
      </span>
    </div>
  )
}

function EditRow({
  spec, value, saved, editable, onCommit, onRemove,
}: {
  spec: Spec; value: string; saved: string; editable: boolean
  onCommit: (v: string) => void
  onRemove?: () => void
}) {
  const [editing, setEditing] = useState(false)
  // Enter/Escape đã xử lý xong ⇒ bỏ qua blur do ô nhập bị gỡ khỏi DOM (Escape không được lưu nhầm số vừa gõ).
  const settled = useRef(false)
  const id = useId()
  const changed = value !== saved
  const d = display(spec.kind, value)
  const clean = (raw: string) => (spec.kind === "money" ? digits(raw) : oneDecimalPoint(raw))
  const commit = (raw: string) => {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    const next = clean(raw)
    if (next !== value) onCommit(next)
  }
  return (
    <div className={rowCls}>
      <label htmlFor={editing ? id : undefined} className="min-w-0 flex-1">
        <div className="text-[15px]">{spec.label}</div>
        <div className="mt-px text-[13px] text-ax-ink-2">{spec.sub}</div>
      </label>
      {editing ? (
        <input
          id={id}
          autoFocus
          aria-label={spec.label}
          inputMode={spec.kind === "money" ? "numeric" : "decimal"}
          defaultValue={value}
          className={cn(AX_INPUT_CLASS, "h-10 w-[170px] text-right text-[15px] max-sm:h-11")}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value)
            if (e.key === "Escape") {
              settled.current = true
              setEditing(false)
            }
          }}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      ) : (
        <button
          type="button"
          disabled={!editable}
          onClick={() => {
            settled.current = false
            setEditing(true)
          }}
          aria-label={`Sửa ${spec.label}, hiện ${d.text}${d.unit}`}
          className={cn(
            "min-h-11 min-w-[150px] rounded-ax-field px-3 text-right text-base font-semibold ax-amount",
            editable ? "cursor-pointer hover:bg-ax-hover" : "cursor-default",
          )}
        >
          {changed && <span aria-hidden className="mr-2 inline-block size-[7px] rounded-full bg-ax-warn align-middle" />}
          {d.text}
          <span className={unitCls}>{d.unit}</span>
        </button>
      )}
      {onRemove && editable && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Bỏ khoản ${spec.label}`}
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-ax-field text-ax-ink-3 hover:bg-ax-hover"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}

export function PayslipDetailView({
  row, position, count, can, canManage, approving, onBack, onPrev, onNext, onApprove, onDownload, onRemove,
}: {
  row: PayslipRow
  /** Số thứ tự (1-based) của phiếu trong danh sách đang lọc, và tổng. */
  position: number
  count: number
  can: (p: "payroll.approve_team" | "payroll.approve_final") => boolean
  canManage: boolean
  approving: boolean
  onBack: () => void
  onPrev: (() => void) | null
  onNext: (() => void) | null
  onApprove: (id: number) => void
  onDownload: (id: number, name: string, kind: "pdf" | "excel") => Promise<void>
  onRemove: (p: PayslipRow) => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<PayslipForm>(() => formFromRow(row))
  const [saved, setSaved] = useState<PayslipForm>(() => formFromRow(row))
  const [added, setAdded] = useState<Set<PayslipFormKey>>(new Set())

  const name = row.employee?.user?.full_name ?? `NV #${row.employee_id}`
  const code = row.employee?.employee_code ?? `NV${String(row.employee_id).padStart(4, "0")}`
  const editable = canEditPayslip(canManage, row.status)
  const dirtyKeys = changedKeys(form, saved)
  const dirty = dirtyKeys.length > 0
  const proj = projectTotals(row, form, saved)
  const totals = totalsFromForm(form)
  const delta = proj.net - Number(row.total ?? 0)
  const step = stepIndex(row.status)

  const saveMutation = useMutation({
    mutationFn: async (f: PayslipForm) => {
      await apiClient.patch(`/payslips/${row.id}`, payloadFromForm(f))
    },
  })

  function setField(key: PayslipFormKey, value: string, silent = false) {
    const old = form[key]
    setForm((f) => ({ ...f, [key]: value }))
    if (silent) return
    showUndoToast("Đã đổi, chưa lưu", { onUndo: () => setForm((f) => ({ ...f, [key]: old })) })
  }

  function save() {
    const prev = saved
    const next = form
    saveMutation.mutate(next, {
      onSuccess: () => {
        setSaved(next)
        void qc.invalidateQueries({ queryKey: ["payroll-payslips", row.month] })
        showUndoToast("Đã lưu phiếu. Bảo hiểm và thuế đã tính lại.", {
          onUndo: () => {
            saveMutation.mutate(prev, {
              onSuccess: () => {
                setSaved(prev)
                setForm(prev)
                void qc.invalidateQueries({ queryKey: ["payroll-payslips", row.month] })
                toast.success("Đã hoàn tác, phiếu về bản trước.")
              },
              onError: (err) => toast.error(errorMessage(err, "Không thể hoàn tác. Vui lòng thử lại.")),
            })
          },
        })
      },
      onError: (err) =>
        toast.error(errorMessage(err, "Không thể lưu. Phiếu đã duyệt không sửa được, hoặc dữ liệu không hợp lệ.")),
    })
  }

  function discard() {
    const prev = form
    setForm(saved)
    setAdded(new Set())
    showUndoToast("Đã bỏ các chỉnh sửa", { onUndo: () => setForm(prev) })
  }

  function applyBonusSuggestion(v: number) {
    setField("bonus_sales_personal", String(v), true)
    toast.success("Đã áp thưởng = doanh số × hệ số. Bạn có thể chỉnh lại.")
  }

  const shown = (s: Spec) => !s.optional || n(saved[s.key]) > 0 || n(form[s.key]) > 0 || added.has(s.key) || (s.kind !== "money" && form[s.key] !== "")
  function renderEdit(s: Spec) {
    return (
      <EditRow
        key={s.key}
        spec={s}
        value={form[s.key]}
        saved={saved[s.key]}
        editable={editable}
        onCommit={(v) => setField(s.key, v)}
        onRemove={
          s.optional
            ? () => {
                const old = form[s.key]
                setField(s.key, "", true)
                setAdded((a) => { const x = new Set(a); x.delete(s.key); return x })
                showUndoToast(`Đã bỏ ${s.label.toLowerCase()}`, {
                  onUndo: () => { setField(s.key, old, true); setAdded((a) => new Set(a).add(s.key)) },
                })
              }
            : undefined
        }
      />
    )
  }
  function addChips(list: Spec[]) {
    const hidden = list.filter((s) => s.optional && !shown(s))
    if (hidden.length === 0 || !editable) return undefined
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-ax-divider px-6 pt-3 pb-4 max-sm:px-4">
        <span className="text-[13px] text-ax-ink-2">Thêm khoản:</span>
        {hidden.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setAdded((a) => new Set(a).add(s.key))}
            className="h-11 cursor-pointer rounded-full border border-dashed border-ax-ink-3 bg-ax-surface px-3.5 text-sm font-semibold text-ax-primary-ink hover:bg-ax-hover lg:h-10"
          >
            + {s.label}
          </button>
        ))}
      </div>
    )
  }

  const rate = form.bonus_rate === "" ? null : Number(form.bonus_rate)
  const suggested = rate !== null && Number.isFinite(rate) && rate > 0 ? Math.round((n(form.sales_personal) * rate) / 100) : 0
  const mismatch = rate !== null && rate > 0 && n(form.bonus_sales_personal) !== suggested
  const phuCap = Number(row.phu_cap_xang_xe ?? 0)
  const compDeductions = (row.components_json ?? []).filter((c) => c.component_type === "deduction")
  const meta = [code, row.employee?.job_title_name ?? row.employee?.position, row.employee?.team_name].filter(Boolean).join(" · ")
  const canRemove = canRemoveFromPeriod(canManage, can("payroll.approve_final"), row.status)
  const canApprove = canApproveNow(can, row.status)

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <nav aria-label="Đường dẫn" className="flex flex-wrap items-center gap-2 text-[13px] text-ax-ink-2">
        <button type="button" onClick={() => { if (!dirty || window.confirm("Bỏ các chỉnh sửa chưa lưu?")) onBack() }} className="cursor-pointer hover:underline">Lương</button>
        <span aria-hidden>/</span>
        <span>Kỳ {formatMonth(row.month)}</span>
        <span aria-hidden>/</span>
        <span className="text-ax-ink">{name}</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <Button variant="ax-secondary" size="ax-icon" aria-label="Nhân viên trước" disabled={!onPrev || dirty} onClick={onPrev ?? undefined}>
            <ChevronLeft className="size-[18px]" aria-hidden />
          </Button>
          <div className="min-w-0">
            <h1 className="ax-text-title truncate">{name}</h1>
            <div className="mt-0.5 text-sm text-ax-ink-2">{meta} · phiếu {position} trên {count}</div>
          </div>
          <Button variant="ax-secondary" size="ax-icon" aria-label="Nhân viên sau" disabled={!onNext || dirty} onClick={onNext ?? undefined}>
            <ChevronRight className="size-[18px]" aria-hidden />
          </Button>
        </div>
        <ol aria-label="Trạng thái phiếu" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "rounded-full px-3.5 py-2 text-[13px] font-semibold",
                i === step ? "bg-ax-primary text-white" : i < step ? "bg-ax-primary-soft-2 text-ax-primary-ink" : "bg-ax-sunken text-ax-ink-2",
              )}
            >
              {i === step && s.id === "pending" ? statusLabel(row.status) : s.name}
            </li>
          ))}
        </ol>
      </div>

      {!editable && (
        <div role="status" className="rounded-ax-card border border-ax-line bg-ax-sunken px-4 py-3 text-sm text-ax-ink-2">
          {row.status === "paid" || row.status === "approved"
            ? "Phiếu đã duyệt nên đang khoá sửa."
            : "Bạn không có quyền sửa số trên phiếu này."}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="order-2 flex min-w-0 flex-1 flex-col gap-4 lg:order-1">
          <Group title="Lương theo công" sum={<Money value={totals.congLcb} />} footer={addChips(BASE_ROWS)}>
            {BASE_ROWS.filter(shown).map(renderEdit)}
            {phuCap > 0 && (
              <ReadRow label="Trong đó phụ cấp xăng xe, ăn ca" sub="Đã nằm trong lương cơ bản, phần vượt mức đóng bảo hiểm" value={phuCap} />
            )}
            <ReadRow
              label="Thực lĩnh lương cơ bản"
              sub={`${n(form.base_salary).toLocaleString("vi-VN")} × ${form.working_days === "" ? "đủ công" : `${form.working_days}/${form.standard_working_days || 24} ngày`} (đơn giá ${totals.donGiaNgayCong.toLocaleString("vi-VN")}₫/ngày)`}
              value={totals.baseActual}
            />
          </Group>

          <Group title="Phụ cấp và thưởng" sum={<><span aria-hidden>+ </span><Money value={totals.congThuong} /></>} sumClass="text-ax-success" footer={addChips(BONUS_ROWS)}>
            {BONUS_ROWS.filter(shown).map(renderEdit)}
            {editable && rate !== null && rate > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ax-divider bg-ax-primary-soft px-6 py-3 max-sm:px-4">
                <span className="text-sm text-ax-primary-ink">
                  Thưởng doanh số gợi ý theo hệ số ({rate}%): <strong className="ax-amount">{fmt(suggested)}</strong>
                </span>
                <Button type="button" variant="ax-secondary" size="ax" onClick={() => applyBonusSuggestion(suggested)}>Áp dụng</Button>
              </div>
            )}
            {mismatch && (
              <p className="border-t border-ax-divider px-6 py-3 text-[13px] text-ax-ink-2 max-sm:px-4">
                Thưởng doanh số hiện tại ({fmt(form.bonus_sales_personal)}) chưa khớp gợi ý theo hệ số ({fmt(suggested)}).
              </p>
            )}
          </Group>

          <Group title="Doanh số và chỉ tiêu">{SALES_ROWS.map(renderEdit)}</Group>

          <Group title="Khấu trừ" sum={<><span aria-hidden>- </span><Money value={proj.ded} /></>} sumClass="text-ax-danger">
            {(row.insurance_json ?? []).map((i) => (
              <ReadRow key={i.code} label={`${i.name} ${i.rate}%`} sub={`Tự tính trên mức đóng ${Number(i.base).toLocaleString("vi-VN")} ₫`} value={i.amount} />
            ))}
            {!(row.insurance_json ?? []).length && Number(row.insurance_total) > 0 && (
              <ReadRow label="Bảo hiểm (người lao động đóng)" sub="Tự tính" value={row.insurance_total} />
            )}
            <ReadRow label="Thuế thu nhập cá nhân" sub="Tự tính theo cấu hình thuế, máy chủ tính lại khi lưu" value={row.tax_total} />
            {compDeductions.map((c) => (
              <ReadRow key={c.code} label={c.name} sub="Thành phần lương, tự tính" value={c.amount} />
            ))}
            {renderEdit(ADVANCE_ROW)}
          </Group>

          <Group title="Ghi chú">
            <div className="border-t border-ax-divider px-6 py-3 max-sm:px-4">
              <textarea
                aria-label="Ghi chú phiếu lương"
                disabled={!editable}
                maxLength={2000}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Ghi chú thêm cho phiếu lương..."
                className={cn(AX_INPUT_CLASS, "min-h-20 w-full py-2")}
              />
            </div>
          </Group>
        </div>

        <aside aria-label="Tổng hợp" className="order-1 flex flex-col gap-4 lg:sticky lg:top-4 lg:order-2 lg:w-[380px] lg:max-w-[440px] lg:shrink-0">
          <HeroCard>
            <HeroCardLabel>Thực nhận tháng {row.month.split("-")[1]}</HeroCardLabel>
            <HeroCardValue unit="₫" className="mt-1">{proj.net.toLocaleString("vi-VN")}</HeroCardValue>
            <div className="mt-[18px] flex justify-between border-t border-white/20 pt-3.5 text-sm">
              <span className="text-[var(--ax-on-hero-ink-2)]">Tổng thu nhập</span>
              <span className="ax-amount">{proj.gross.toLocaleString("vi-VN")}<span className="ml-0.5 text-[0.8em]">₫</span></span>
            </div>
            <div className="mt-2 flex justify-between text-sm">
              <span className="text-[var(--ax-on-hero-ink-2)]">Tổng khấu trừ</span>
              <span className="ax-amount">{proj.ded.toLocaleString("vi-VN")}<span className="ml-0.5 text-[0.8em]">₫</span></span>
            </div>
            <p className="mt-3 text-[12px] leading-snug text-[var(--ax-on-hero-ink-2)]">
              Số tạm tính tại đây. Bảo hiểm và thuế được máy chủ tính lại khi lưu.
            </p>
            {dirty && (
              <div className="mt-4 rounded-ax-card bg-[var(--ax-stage-consult-bg)] p-3 text-[13px] leading-snug text-[var(--ax-stage-consult-ink)]">
                Đã sửa {dirtyKeys.length} khoản. Thực nhận {delta >= 0 ? "tăng" : "giảm"} {fmt(Math.abs(delta))} so với bản đã lưu.
              </div>
            )}
            {dirty && editable && (
              <div className="mt-4 flex gap-2 max-lg:hidden">
                <Button variant="ax-on-hero-secondary" size="ax-lg" onClick={discard} disabled={saveMutation.isPending}>Bỏ sửa</Button>
                <Button variant="ax-on-hero" size="ax-lg" className="flex-1" onClick={save} disabled={saveMutation.isPending}>
                  {saveMutation.isPending && <Loader2 className="animate-spin" aria-hidden />}Lưu phiếu
                </Button>
              </div>
            )}
            {!dirty && canApprove && (
              <Button variant="ax-on-hero" size="ax-lg" className="mt-[18px] w-full" disabled={approving} onClick={() => onApprove(row.id)}>
                {approving && <Loader2 className="animate-spin" aria-hidden />}Duyệt phiếu này
              </Button>
            )}
            {dirty && canApprove && <p className="mt-2 text-[12px] text-[var(--ax-on-hero-ink-2)]">Lưu phiếu trước khi duyệt.</p>}
          </HeroCard>

          <section aria-label="Chi trả và xuất phiếu" className="ax-card p-5 px-6">
            <h2 className="mb-1 text-[15px] font-bold tracking-[-0.011em]">Chi trả</h2>
            <p className="mb-3 text-sm leading-snug text-ax-ink-2">
              Tài khoản <strong className="text-ax-ink">{row.employee?.bank_account_number || "—"}</strong>
              {row.employee?.bank_name ? ` · ${row.employee.bank_name}` : ""}. Lấy từ hồ sơ nhân viên.
            </p>
            {/* Chừa chỗ: «Chốt kỳ» (chốt cả kỳ) và «Ẩn/hiện số» chưa có API — làm ở PR riêng. */}
            <div className="flex flex-col gap-2">
              <Button variant="ax-secondary" size="ax-lg" onClick={() => void onDownload(row.id, name, "pdf")}>
                <Download aria-hidden />Xuất PDF
              </Button>
              <Button variant="ax-secondary" size="ax-lg" onClick={() => void onDownload(row.id, name, "excel")}>
                <FileSpreadsheet aria-hidden />Xuất Excel
              </Button>
              {canRemove && (
                <Button variant="ax-danger" size="ax-lg" onClick={() => onRemove(row)}>
                  <Trash2 aria-hidden />Loại khỏi kỳ
                </Button>
              )}
            </div>
          </section>
        </aside>
      </div>

      {dirty && editable && (
        <StickyActionBar layout="mobile" className="lg:hidden">
          <Button variant="ax-secondary" size="ax" onClick={discard} disabled={saveMutation.isPending}>Bỏ sửa</Button>
          <Button variant="ax-primary" size="ax" onClick={save} disabled={saveMutation.isPending}>
            {saveMutation.isPending && <Loader2 className="animate-spin" aria-hidden />}Lưu phiếu
          </Button>
        </StickyActionBar>
      )}
    </div>
  )
}
