"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp, Clock, History, Loader2, MessageSquareText, Pencil, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { OptionSelect } from "./option-select"
import {
  useChatLinks,
  useFlowRuns,
  useMessageFlowMutations,
  useMessageFlows,
  type FacebookPageView,
  type FlowAsk,
  type FlowRunStatus,
  type FlowStep,
  type FlowTrigger,
  type MessageFlow,
} from "./use-facebook"
import { apiErrorMessage } from "./webhook-types"

export const TRIGGER_LABELS: Record<FlowTrigger, string> = {
  keyword: "Khách nhắn có từ khoá",
  chat_link: "Khách vào qua link / QR",
  first_message: "Tin đầu tiên của khách mới",
}
const ASK_LABELS: Record<FlowAsk, string> = { phone: "Số điện thoại", email: "Email", note: "Câu trả lời tự do (ghi chú)" }
const RUN_LABELS: Record<FlowRunStatus, string> = {
  waiting_button: "Chờ khách bấm nút",
  waiting_answer: "Chờ khách trả lời",
  scheduled: "Chờ tới giờ gửi",
  sending: "Đang gửi",
  done: "Đi hết kịch bản",
  stopped: "Đã dừng",
  expired: "Quá 24 giờ",
  failed: "Lỗi",
}
const MAX_STEPS = 20
const MAX_BUTTONS = 10
const NEXT_STEP = "__next"
const END = "__end"

/** Cách đi tiếp sau một bước. */
type StepKind = "auto" | "buttons" | "ask"
const kindOf = (s: FlowStep): StepKind => (s.buttons?.length ? "buttons" : s.ask ? "ask" : "auto")

/** Bản sao bước bỏ các trường đã chọn. */
function without(s: FlowStep, ...keys: Array<keyof FlowStep>): FlowStep {
  const c = { ...s }
  for (const k of keys) delete c[k]
  return c
}

/** Mã bước mới chưa dùng: s1, s2… */
export function newStepId(steps: FlowStep[]): string {
  const used = new Set(steps.map((s) => s.id))
  for (let i = steps.length + 1; ; i++) if (!used.has(`s${i}`)) return `s${i}`
}

/** Nhãn ngắn cho một bước trong ô chọn "đi tới". */
const stepLabel = (steps: FlowStep[], id: string) => {
  const i = steps.findIndex((s) => s.id === id)
  const s = steps[i]
  return s ? `Bước ${i + 1}: ${s.text.slice(0, 30) || "(chưa có nội dung)"}` : id
}

/** Kiểm nhanh phía trình duyệt (máy chủ kiểm lại đầy đủ). Trả câu lỗi đầu tiên hoặc null. */
export function flowProblem(name: string, trigger: FlowTrigger, keywords: string[], linkId: string, steps: FlowStep[]): string | null {
  if (!name.trim()) return "Đặt tên cho kịch bản"
  if (trigger === "keyword" && !keywords.length) return "Nhập ít nhất một từ khoá"
  if (trigger === "chat_link" && !linkId) return "Chọn link / QR mở chat"
  if (!steps.length) return "Thêm ít nhất một bước"
  for (const [i, s] of steps.entries()) {
    if (!s.text.trim()) return `Bước ${i + 1}: chưa có nội dung tin`
    if (s.buttons?.some((b) => !b.title.trim())) return `Bước ${i + 1}: có nút chưa đặt chữ`
  }
  return null
}

function StepEditor({ steps, index, onChange, onMove, onRemove }: {
  steps: FlowStep[]
  index: number
  onChange: (s: FlowStep) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const s = steps[index]
  const kind = kindOf(s)
  const others = steps.filter((x) => x.id !== s.id)
  const targetOptions = [...others.map((x) => ({ value: x.id, label: stepLabel(steps, x.id) })), { value: END, label: "Kết thúc kịch bản" }]
  const setKind = (k: StepKind) => {
    const rest = without(s, "buttons", "ask")
    if (k === "buttons") onChange({ ...rest, buttons: [{ title: "", next: null }] })
    else if (k === "ask") onChange({ ...rest, ask: "phone" })
    else onChange(rest)
  }
  const autoNext = s.next === undefined ? NEXT_STEP : s.next === null ? END : s.next
  return (
    <Card data-testid="flow-step">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Bước {index + 1}</p>
          <span className="text-xs text-muted-foreground">mã {s.id}</span>
          <div className="ml-auto flex gap-1">
            <Button size="icon" variant="ghost" className="size-8" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Đưa bước ${index + 1} lên`}><ArrowUp className="size-4" /></Button>
            <Button size="icon" variant="ghost" className="size-8" disabled={index === steps.length - 1} onClick={() => onMove(1)} aria-label={`Đưa bước ${index + 1} xuống`}><ArrowDown className="size-4" /></Button>
            <Button size="icon" variant="ghost" className="size-8" disabled={steps.length === 1} onClick={onRemove} aria-label={`Xoá bước ${index + 1}`}><Trash2 className="size-4" /></Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`flow-step-${s.id}`}>Nội dung tin</Label>
          <Textarea id={`flow-step-${s.id}`} value={s.text} maxLength={2000} rows={3} onChange={(e) => onChange({ ...s, text: e.target.value })} placeholder="Chào {ten}! Mình có thể giúp gì cho bạn?" />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Chờ trước khi gửi (phút)
            <Input
              type="number"
              min={0}
              max={1380}
              value={s.wait_minutes ?? 0}
              onChange={(e) => {
                const w = Math.max(0, Math.min(1380, Math.floor(Number(e.target.value) || 0)))
                const rest = without(s, "wait_minutes")
                onChange(w ? { ...rest, wait_minutes: w } : rest)
              }}
              className="h-8 w-28 max-sm:h-11"
              aria-label={`Chờ trước khi gửi bước ${index + 1}`}
            />
          </label>
          <OptionSelect
            label="Sau khi gửi"
            value={kind}
            onChange={(v) => setKind(v as StepKind)}
            options={[
              { value: "auto", label: "Đi tiếp" },
              { value: "buttons", label: "Hiện nút cho khách chọn" },
              { value: "ask", label: "Hỏi và lưu câu trả lời" },
            ]}
            className="h-8 w-[210px] text-sm max-sm:h-11 max-sm:w-full"
          />
          {kind === "auto" && (
            <OptionSelect
              label="Đi tới"
              value={autoNext}
              onChange={(v) => {
                const rest = without(s, "next")
                onChange(v === NEXT_STEP ? rest : { ...rest, next: v === END ? null : v })
              }}
              options={[{ value: NEXT_STEP, label: "Bước kế tiếp" }, ...targetOptions]}
              className="h-8 w-[220px] text-sm max-sm:h-11 max-sm:w-full"
            />
          )}
          {kind === "ask" && (
            <OptionSelect
              label="Lưu vào"
              value={s.ask ?? "phone"}
              onChange={(v) => onChange({ ...s, ask: v as FlowAsk })}
              options={(Object.keys(ASK_LABELS) as FlowAsk[]).map((k) => ({ value: k, label: ASK_LABELS[k] }))}
              className="h-8 w-[220px] text-sm max-sm:h-11 max-sm:w-full"
            />
          )}
        </div>
        {kind === "buttons" && (
          <div className="space-y-2">
            {s.buttons?.map((b, j) => (
              <div key={j} className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Chữ trên nút {j + 1}
                  <Input
                    value={b.title}
                    maxLength={20}
                    onChange={(e) => onChange({ ...s, buttons: s.buttons?.map((x, k) => (k === j ? { ...x, title: e.target.value } : x)) })}
                    className="h-8 w-40 max-sm:h-11"
                    placeholder="vd Xem học phí"
                  />
                </label>
                <OptionSelect
                  label="Khách bấm thì đi tới"
                  value={b.next ?? END}
                  onChange={(v) => onChange({ ...s, buttons: s.buttons?.map((x, k) => (k === j ? { ...x, next: v === END ? null : v } : x)) })}
                  options={targetOptions}
                  className="h-8 w-[220px] text-sm max-sm:h-11 max-sm:w-full"
                />
                <Button size="icon" variant="ghost" className="size-8" disabled={(s.buttons?.length ?? 0) <= 1} onClick={() => onChange({ ...s, buttons: s.buttons?.filter((_x, k) => k !== j) })} aria-label={`Bỏ nút ${j + 1}`}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" disabled={(s.buttons?.length ?? 0) >= MAX_BUTTONS} onClick={() => onChange({ ...s, buttons: [...(s.buttons ?? []), { title: "", next: null }] })}>
              <Plus className="size-4" /> Thêm nút
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Xem trước dạng khung chat: các bước theo thứ tự, nút là các chip, thời gian chờ là dòng chia. */
function FlowPreview({ steps }: { steps: FlowStep[] }) {
  return (
    <div className="space-y-2 self-start rounded-lg bg-muted/50 p-3 lg:sticky lg:top-0" aria-label="Xem trước kịch bản">
      <p className="text-xs font-medium text-muted-foreground">Xem trước (khách tên Lan)</p>
      {steps.map((s, i) => (
        <div key={s.id} className="space-y-1">
          {s.wait_minutes ? (
            <p className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground"><Clock className="size-3" /> chờ {s.wait_minutes} phút</p>
          ) : null}
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-background px-3 py-2 text-sm shadow-sm">
            <span className="mr-1 text-[10px] text-muted-foreground">{i + 1}</span>
            {s.text.replace(/\{\s*ten\s*\}/gi, "Lan") || <span className="text-muted-foreground">(chưa có nội dung)</span>}
          </div>
          {s.buttons?.length ? (
            <div className="flex flex-wrap gap-1">
              {s.buttons.map((b, j) => (
                <span key={j} className="rounded-full border border-primary/40 bg-background px-2 py-0.5 text-xs text-primary">{b.title || "…"}</span>
              ))}
            </div>
          ) : null}
          {s.ask ? <p className="text-[11px] text-muted-foreground">↳ chờ khách trả lời, lưu {ASK_LABELS[s.ask].toLowerCase()}</p> : null}
        </div>
      ))}
    </div>
  )
}

function FlowDialog({ open, onOpenChange, pages, flow }: { open: boolean; onOpenChange: (o: boolean) => void; pages: FacebookPageView[]; flow: MessageFlow | null }) {
  const m = useMessageFlowMutations()
  const links = useChatLinks(open)
  const [name, setName] = useState(flow?.name ?? "")
  const [pageId, setPageId] = useState(flow?.page_id ?? pages[0]?.page_id ?? "")
  const [trigger, setTrigger] = useState<FlowTrigger>(flow?.trigger ?? "keyword")
  const [keywords, setKeywords] = useState((flow?.keywords ?? []).join(", "))
  const [linkId, setLinkId] = useState(flow?.chat_link_id ? String(flow.chat_link_id) : "")
  const [steps, setSteps] = useState<FlowStep[]>(flow?.steps ?? [{ id: "s1", text: "" }])
  const kw = keywords.split(",").map((k) => k.trim()).filter(Boolean)
  const pageLinks = (links.data ?? []).filter((l) => l.page_id === pageId)

  const setStep = (i: number, s: FlowStep) => setSteps((all) => all.map((x, k) => (k === i ? s : x)))
  const move = (i: number, dir: -1 | 1) =>
    setSteps((all) => {
      const next = [...all]
      ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
      return next
    })
  const removeStep = (i: number) =>
    setSteps((all) => {
      const gone = all[i].id
      // Nút / "đi tới" đang trỏ bước bị xoá ⇒ đổi thành kết thúc.
      return all
        .filter((_x, k) => k !== i)
        .map((s) => ({
          ...s,
          ...(s.next === gone ? { next: null } : {}),
          ...(s.buttons ? { buttons: s.buttons.map((b) => (b.next === gone ? { ...b, next: null } : b)) } : {}),
        }))
    })

  const save = () => {
    const problem = flowProblem(name, trigger, kw, linkId, steps)
    if (problem) return toast.error(problem)
    const body = {
      name: name.trim(),
      trigger,
      keywords: trigger === "keyword" ? kw : [],
      chat_link_id: trigger === "chat_link" ? Number(linkId) : null,
      steps: steps.map((s) => ({ ...s, text: s.text.trim(), buttons: s.buttons?.map((b) => ({ ...b, title: b.title.trim() })) })),
    }
    const done = { onSuccess: () => { toast.success(flow ? "Đã lưu kịch bản" : "Đã tạo kịch bản — bật lên khi sẵn sàng"); onOpenChange(false) }, onError: (e: unknown) => toast.error(apiErrorMessage(e, "Không lưu được")) }
    if (flow) m.update.mutate({ id: flow.id, ...body }, done)
    else m.create.mutate({ ...body, page_id: pageId }, done)
  }
  const pending = m.create.isPending || m.update.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{flow ? "Sửa kịch bản nhắn tin" : "Tạo kịch bản nhắn tin"}</DialogTitle>
          <DialogDescription>
            Trinity tự nhắn cho khách trên Messenger theo từng bước. Messenger chỉ cho nhắn trong 24 giờ kể từ tin cuối của khách nên kịch bản tự dừng khi quá hạn; nhân viên trả lời trong Trinity thì kịch bản dừng để người tiếp.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="space-y-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="flow-name">Tên kịch bản</Label>
              <Input id="flow-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder='vd "Chào khách hỏi học phí"' />
            </div>
            <div className="flex flex-wrap gap-3">
              {!flow && pages.length > 1 && (
                <OptionSelect label="Fanpage" value={pageId} onChange={setPageId} options={pages.map((p) => ({ value: p.page_id, label: p.name }))} className="h-9 w-[200px] max-sm:h-11 max-sm:w-full" />
              )}
              <OptionSelect
                label="Bắt đầu khi"
                value={trigger}
                onChange={(v) => setTrigger(v as FlowTrigger)}
                options={(Object.keys(TRIGGER_LABELS) as FlowTrigger[]).map((k) => ({ value: k, label: TRIGGER_LABELS[k] }))}
                className="h-9 w-[240px] max-sm:h-11 max-sm:w-full"
              />
              {trigger === "chat_link" && (
                <OptionSelect
                  label="Link / QR"
                  value={linkId}
                  onChange={setLinkId}
                  placeholder={pageLinks.length ? "Chọn link" : "Chưa có link — tạo ở mục Link / QR"}
                  options={pageLinks.map((l) => ({ value: String(l.id), label: l.name }))}
                  className="h-9 w-[220px] max-sm:h-11 max-sm:w-full"
                />
              )}
            </div>
            {trigger === "keyword" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="flow-keywords">Từ khoá (cách nhau bằng dấu phẩy, không phân biệt dấu)</Label>
                <Input id="flow-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="học phí, giá, bao nhiêu tiền" />
              </div>
            )}
            {trigger === "first_message" && <p className="text-xs text-muted-foreground">Chạy với tin đầu tiên của người lần đầu nhắn Fanpage. Có nhiều kịch bản loại này đang bật thì dùng cái mới nhất.</p>}
            <div className="space-y-2">
              {steps.map((s, i) => (
                <StepEditor key={s.id} steps={steps} index={i} onChange={(x) => setStep(i, x)} onMove={(d) => move(i, d)} onRemove={() => removeStep(i)} />
              ))}
              <Button variant="outline" size="sm" disabled={steps.length >= MAX_STEPS} onClick={() => setSteps((all) => [...all, { id: newStepId(all), text: "" }])}>
                <Plus className="size-4" /> Thêm bước
              </Button>
            </div>
          </div>
          <FlowPreview steps={steps} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={save} disabled={pending || !pageId}>{pending && <Loader2 className="size-4 animate-spin" />} {flow ? "Lưu" : "Tạo kịch bản"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunsList({ flowId }: { flowId: number }) {
  const runs = useFlowRuns(flowId, true)
  if (runs.isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Đang tải" />
  if (runs.isError) return <p className="text-sm text-destructive">Không tải được lượt chạy.</p>
  if (!runs.data?.length) return <p className="text-sm text-muted-foreground">Chưa có khách nào đi qua kịch bản này.</p>
  return (
    <ul className="divide-y text-sm" data-testid="flow-runs">
      {runs.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
          <span className="font-medium">{r.customer_name ?? `Hội thoại #${r.conversation_id}`}</span>
          <Badge variant={r.status === "done" ? "success" : r.status === "failed" ? "destructive" : "secondary"}>{RUN_LABELS[r.status] ?? r.status}</Badge>
          {r.step_id && <span className="text-xs text-muted-foreground">ở bước {r.step_id}</span>}
          {r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
          <span className="ml-auto text-xs text-muted-foreground">{new Date(r.started_at).toLocaleString("vi-VN")}</span>
        </li>
      ))}
    </ul>
  )
}

function FlowCard({ f, pages, highlight }: { f: MessageFlow; pages: FacebookPageView[]; highlight: boolean }) {
  const m = useMessageFlowMutations()
  const [edit, setEdit] = useState(false)
  const [del, setDel] = useState(false)
  const [showRuns, setShowRuns] = useState(highlight)
  const how = f.trigger === "keyword" ? `${TRIGGER_LABELS.keyword}: ${f.keywords.join(", ")}` : f.trigger === "chat_link" ? `${TRIGGER_LABELS.chat_link}: ${f.chat_link_name ?? "(link đã xoá)"}` : TRIGGER_LABELS.first_message
  return (
    <Card id={`flow-${f.id}`} className={cn(highlight && "ring-2 ring-primary")} data-testid="flow-card">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{f.name}</p>
          <Badge variant={f.is_active ? "success" : "secondary"}>{f.is_active ? "Đang bật" : "Đang tắt"}</Badge>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <Switch
              checked={f.is_active}
              disabled={m.update.isPending}
              onCheckedChange={(v) => m.update.mutate({ id: f.id, is_active: v === true }, { onError: (e) => toast.error(apiErrorMessage(e, "Không đổi được")) })}
              aria-label={`Bật kịch bản ${f.name}`}
            />
            Bật
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Fanpage {f.page_name ?? f.page_id} · {how} · {f.steps.length} bước</p>
        <p className="text-sm"><b>{f.starts}</b> lượt chạy · <b>{f.completes}</b> đi hết · <b>{f.running}</b> đang dở</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil className="size-4" /> Sửa</Button>
          <Button size="sm" variant="outline" aria-expanded={showRuns} onClick={() => setShowRuns((x) => !x)}><History className="size-4" /> Lượt chạy</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-red-600" onClick={() => setDel(true)} aria-label={`Xoá kịch bản ${f.name}`}><Trash2 className="size-4" /></Button>
        </div>
        {showRuns && <RunsList flowId={f.id} />}
      </CardContent>
      {edit && <FlowDialog open={edit} onOpenChange={setEdit} pages={pages} flow={f} />}
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Xoá kịch bản?"
        description={<>Kịch bản <b>{f.name}</b> và lịch sử lượt chạy sẽ bị xoá; khách đang ở giữa kịch bản sẽ không nhận tin tiếp. Tin đã gửi vẫn nằm trong hộp thư. Muốn tạm dừng thì tắt thay vì xoá.</>}
        confirmLabel="Xoá kịch bản"
        pending={m.remove.isPending}
        onConfirm={() => m.remove.mutate(f.id, { onSuccess: () => { toast.success("Đã xoá kịch bản"); setDel(false) }, onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) })}
      />
    </Card>
  )
}

/** Cài đặt › Fanpage › Kịch bản nhắn tin: tự nhắn riêng nhiều bước trên Messenger (chào, nút rẽ nhánh, xin SĐT/email, nhắc sau). */
export function FacebookFlows({ pages, highlight }: { pages: FacebookPageView[]; highlight?: number }) {
  const flows = useMessageFlows(true)
  const [open, setOpen] = useState(false)
  const active = pages.filter((p) => p.is_active)
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tự trả lời khách trên Messenger theo kịch bản nhiều bước: chào khách, cho khách bấm nút chọn nhu cầu, xin số điện thoại hoặc email rồi lưu vào khách hàng, nhắc lại sau vài phút. Kịch bản mới tạo đang tắt — xem lại rồi bật.
      </p>
      <Button onClick={() => setOpen(true)} disabled={!active.length} className="max-sm:h-11"><Plus className="size-4" /> Tạo kịch bản</Button>
      {!active.length && <p className="text-xs text-muted-foreground">Cần kết nối một Fanpage trước (mục Fanpage).</p>}
      {flows.isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Đang tải" />}
      {flows.isError && <p className="text-sm text-destructive">Không tải được danh sách kịch bản.</p>}
      {flows.isSuccess && flows.data.length === 0 && <EmptyState icon={MessageSquareText} message="Chưa có kịch bản nhắn tin nào." action={<Button variant="outline" onClick={() => setOpen(true)} disabled={!active.length}><Plus className="size-4" /> Soạn kịch bản</Button>} />}
      <div className="grid gap-3 xl:grid-cols-2">
        {flows.data?.map((f) => <FlowCard key={f.id} f={f} pages={active} highlight={f.id === highlight} />)}
      </div>
      {open && <FlowDialog open={open} onOpenChange={setOpen} pages={active} flow={null} />}
    </div>
  )
}
