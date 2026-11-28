"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, ImagePlus, Images, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { useOffline } from "@/components/offline-banner"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AX_INPUT_CLASS, Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { buttonVariants } from "@/components/ui/button-variants"
import { cn } from "@/lib/utils"
import { NETWORK_META, NetworkMark } from "./social-network-mark"
import { getApiErrorMessage } from "@/lib/api-client"
import {
  CAPTION_LIMITS,
  uploadSocialFile,
  useQueueNext,
  useQueueSlots,
  useSocialAccounts,
  useSocialMutations,
  useSocialSnippets,
  type SocialAccount,
  type SocialDraft,
  type SocialLibraryItem,
  type SocialMediaItem,
} from "@/hooks/use-social"
import { SocialLibrary } from "./social-library"
import { SocialPreviewPanel } from "./social-preview"
import { queueWhenLabel } from "./social-queue"
import { SnippetMenu, SocialSnippetsDialog, insertSnippet, signaturePrefill } from "./social-snippets"
import { EMPTY_UTM_CHOICE, defaultCampaign, firstLinkWithUtm, utmPayload, withUtm, type UtmChoice } from "./social-utm"
import { composerStateFrom, type ComposerState } from "./social-draft-state"
import { RecurrenceFields } from "./social-recurrence"
import { emptyRecurrence, recurrenceError, recurrenceSchedule } from "./social-recurrence-rules"
import { todayVn } from "@/lib/format"
import { STATUS_LABEL } from "@/components/ui/status-tag"
import { formatDateTime } from "@/lib/format"

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.mov"

interface Upload {
  id: string
  name: string
  pct: number
  item?: SocialMediaItem
  error?: string
  libId?: number
}

/** Hẹn tối đa 90 ngày tới — khớp `MAX_SCHEDULE_AHEAD_MS` phía BE. */
const MAX_SCHEDULE_AHEAD_MS = 90 * 86_400_000

/** `Date` → giá trị ô `datetime-local` theo giờ máy người dùng (YYYY-MM-DDTHH:mm). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Lỗi của giờ hẹn (null = hợp lệ). Ô `datetime-local` hiểu theo giờ máy người dùng. */
export function scheduleError(value: string, now = Date.now()): string | null {
  if (!value) return "Chọn ngày giờ đăng."
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return "Ngày giờ không hợp lệ."
  if (t <= now + 60_000) return "Giờ hẹn phải sau bây giờ ít nhất 1 phút."
  if (t - now > MAX_SCHEDULE_AHEAD_MS) return "Chỉ hẹn trước tối đa 90 ngày."
  return null
}

function Counter({ text, limit }: { text: string; limit: number }) {
  const over = text.length > limit
  return <span className={over ? "font-medium text-[var(--ax-danger-ink)]" : "text-ax-ink-3"}>{text.length.toLocaleString("vi-VN")}/{limit.toLocaleString("vi-VN")}</span>
}

/** Soạn một lần, chọn kênh, sửa nội dung riêng từng kênh, đăng ngay. */
export function SocialComposer({ onCreated, onGoChannels, onGoCalendar, preset, draft, onClose }: { onCreated: (kind?: "recurring") => void; onGoChannels: () => void; onGoCalendar?: () => void; preset?: { at: string; n: number }; draft?: SocialDraft; onClose?: () => void }) {
  const offline = useOffline()
  const accountsQ = useSocialAccounts()
  const { data: accounts = [], isLoading } = accountsQ
  const { create, saveDraft, publishDraft, createRecurrence } = useSocialMutations()
  // Mở từ một nháp: khôi phục trạng thái ô soạn một lần lúc dựng (đổi nháp ⇒ màn cha dựng lại bằng `key`).
  const [init] = useState<ComposerState | null>(() => (draft ? composerStateFrom(draft) : null))
  /** Nháp đang mở / vừa lưu: lưu tiếp thì sửa nháp này; đăng xong thì xoá nháp. */
  const [draftId, setDraftId] = useState<number | undefined>(draft?.id)
  const [content, setContent] = useState(init?.content ?? "")
  // Mẫu chữ: bài mới bắt đầu trống (không từ nháp) được điền sẵn chữ ký mặc định, đúng một lần khi danh sách mẫu về.
  const snippetsQ = useSocialSnippets()
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const prefilled = useRef(Boolean(draft))
  /** Đúng giá trị đã tự điền (để chỉ coi "chưa gõ gì" khi nội dung còn y nguyên giá trị đó). */
  const prefillValue = useRef<string | null>(null)
  // Tăng sau mỗi lần đăng xong ⇒ bài mới kế tiếp được điền lại chữ ký.
  const [refill, setRefill] = useState(0)
  useEffect(() => {
    if (prefilled.current || !snippetsQ.isSuccess) return
    prefilled.current = true
    const pre = signaturePrefill(snippetsQ.data)
    if (pre) setContent((c) => {
      if (c !== "") return c
      prefillValue.current = pre
      return pre
    })
  }, [snippetsQ.isSuccess, snippetsQ.data, refill])
  const [selected, setSelected] = useState<number[]>(init?.selected ?? [])
  const [captions, setCaptions] = useState<Record<number, string>>(init?.captions ?? {})
  const [openCaption, setOpenCaption] = useState<Record<number, boolean>>(init?.openCaption ?? {})
  const [fbFirst, setFbFirst] = useState<Record<number, string>>(init?.fbFirst ?? {})
  const [uploads, setUploads] = useState<Upload[]>(() =>
    (init?.uploads ?? []).map((u) => ({ id: `draft-${u.item.key}`, name: u.name, pct: 100, item: u.item, libId: u.libId })),
  )
  const [scheduleOn, setScheduleOn] = useState(init?.scheduleOn ?? false)
  const [scheduleAt, setScheduleAt] = useState(init?.scheduleAt ?? "")
  /** "Vào hàng đợi": máy chủ chọn khung trống gần nhất lúc đăng; nháp không lưu giờ. */
  const [useQueue, setUseQueue] = useState(init?.useQueue ?? false)
  /** "Gắn UTM vào liên kết": tên chiến dịch để trống = tên mặc định từ nội dung. */
  const [utm, setUtm] = useState<UtmChoice>(init?.utm ?? EMPTY_UTM_CHOICE)
  const slotsQ = useQueueSlots()
  const noSlots = slotsQ.isSuccess && slotsQ.data.length === 0
  /** Điện thoại: bước 1 «Bài mới» (nội dung + kênh) → bước 2 «Xem lại và đăng». Từ 1024px hiện đủ một màn, không dùng. */
  const [step, setStep] = useState<"edit" | "review">("edit")
  const [triedNext, setTriedNext] = useState(false)
  /** Điện thoại: bấm ✕ khi còn bài đang soạn ⇒ hỏi giữ nháp hay bỏ. */
  const [closeAsk, setCloseAsk] = useState(false)
  /** Vùng cuộn của màn soạn toàn màn (điện thoại) — về đầu khi đổi bước. */
  const bodyRef = useRef<HTMLDivElement>(null)
  const nextQ = useQueueNext(1, useQueue || (slotsQ.data?.length ?? 0) > 0)
  const nextSlot = nextQ.data?.[0]
  /** "Lặp lại": tạo lịch lặp (không tạo bài ngay); máy chủ tự hẹn từng bài kế tiếp. */
  const [recurOn, setRecurOn] = useState(init?.recurOn ?? false)
  const [recur, setRecur] = useState(() => init?.recur ?? emptyRecurrence(todayVn()))
  const mode: "now" | "schedule" | "queue" | "recurring" = recurOn ? "recurring" : useQueue ? "queue" : scheduleOn ? "schedule" : "now"
  const pickMode = (m: "now" | "schedule" | "queue" | "recurring") => {
    setRecurOn(m === "recurring")
    setUseQueue(m === "queue")
    setScheduleOn(m === "schedule")
    if (m === "schedule" && !scheduleAt) setScheduleAt(toLocalInput(new Date(Date.now() + 60 * 60_000)))
  }
  // Chọn ngày từ Lịch: bật hẹn giờ, điền giờ (quá giờ hôm nay thì để người dùng sửa — ô báo lỗi ngay).
  useEffect(() => {
    if (!preset) return
    setScheduleOn(true)
    setUseQueue(false)
    setScheduleAt(preset.at)
  }, [preset])

  const active = accounts.filter((a) => a.status === "active")
  const chosen = active.filter((a) => selected.includes(a.id))
  const uploading = uploads.some((u) => !u.item && !u.error)
  const media = uploads.flatMap((u) => (u.item ? [u.item] : []))

  const addFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const id = `${Date.now()}-${Math.random()}`
      setUploads((u) => [...u, { id, name: file.name, pct: 0 }])
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)))
      uploadSocialFile(file, (pct) => patch({ pct }))
        .then((item) => patch({ item, pct: 100 }))
        .catch((err) => patch({ error: getApiErrorMessage(err, "Tải tệp không thành công") }))
    }
  }

  // Tệp chọn từ thư viện vào thẳng danh sách đính kèm như tệp đã tải xong (id `lib-<key>` để bấm lại là bỏ chọn).
  const [libOpen, setLibOpen] = useState(false)
  const pickedKeys = uploads.flatMap((u) => (u.item ? [u.item.key] : []))
  const togglePick = (m: SocialLibraryItem) =>
    setUploads((u) =>
      u.some((x) => x.item?.key === m.key)
        ? u.filter((x) => x.item?.key !== m.key)
        : [...u, { id: `lib-${m.key}`, name: m.name, pct: 100, item: { key: m.key, type: m.type, content_type: m.content_type, size: m.size }, libId: m.id }],
    )

  const toggle = (a: SocialAccount) => setSelected((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]))

  const utmCfg = utmPayload(utm, content)

  /** Kênh đã chọn + nội dung riêng + tuỳ chọn từng mạng — dùng chung cho đăng và lưu nháp. */
  const buildTargets = () =>
    chosen.map((a) => ({
      account_id: a.id,
      caption: openCaption[a.id] && captions[a.id]?.trim() ? captions[a.id] : null,
      options: fbFirst[a.id]?.trim() ? { first_comment: fbFirst[a.id].trim() } : undefined,
    }))

  /** Toàn bộ trạng thái ô soạn ⇒ thân nháp (dùng cho Lưu nháp và trước khi đăng nháp đang mở). */
  const draftBody = () => {
    const at = scheduleOn && !useQueue && scheduleAt ? new Date(scheduleAt) : null
    const ui: ComposerState = {
      content, selected, captions, openCaption, fbFirst, scheduleOn, scheduleAt, useQueue, utm, recurOn, recur,
      uploads: uploads.flatMap((u) => (u.item ? [{ name: u.name, item: u.item, libId: u.libId }] : [])),
    }
    return {
      content,
      media: uploads.flatMap((u) => (u.item ? [{ key: u.item.key, name: u.name }] : [])),
      targets: buildTargets(),
      scheduled_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      use_queue: useQueue,
      utm: utmCfg,
      ui: ui as unknown as Record<string, unknown>,
    }
  }

  const saveAsDraft = () => {
    saveDraft.mutate(
      { id: draftId, body: draftBody() },
      {
        onSuccess: (d) => {
          setDraftId(d.id)
          toast.success("Đã lưu bài nháp.", { description: "Mở lại ở tab Nháp." })
        },
        onError: (err) => toast.error(getApiErrorMessage(err, "Không lưu được bài nháp")),
      },
    )
  }

  const submitRecurring = () => {
    const title = content.trim().replace(/\s+/g, " ").slice(0, 60) || "Bài lặp lại"
    createRecurrence.mutateAsync({ title, template: { content, media_keys: media.map((m) => m.key), targets: buildTargets(), ...(utmCfg ? { utm: utmCfg } : {}) }, ...recurrenceSchedule(recur) }).then(
      (r) => {
        toast.success(`Đã tạo bài lặp lại "${r.title}".`, { description: r.last_error ?? "Quản lý ở tab Lịch › Bài lặp lại." })
        setRecurOn(false)
        setContent("")
        setSelected([])
        setCaptions({})
        setOpenCaption({})
        setFbFirst({})
        setUtm(EMPTY_UTM_CHOICE)
        setUploads([])
        setRecur(emptyRecurrence(todayVn()))
        prefilled.current = false
        setRefill((n) => n + 1)
        setStep("edit")
        setTriedNext(false)
        onCreated("recurring")
      },
      (err) => toast.error(getApiErrorMessage(err, "Không tạo được bài lặp lại")),
    )
  }

  const submit = () => {
    if (recurOn) return submitRecurring()
    const scheduledAt = scheduleOn && !useQueue ? new Date(scheduleAt).toISOString() : null
    // Đang mở một nháp: lưu bản đang thấy rồi đăng QUA nháp (máy chủ giữ chỗ ⇒ hai người mở cùng nháp không đăng hai lần,
    // và chỉ đăng đúng bản vừa lưu). Không có nháp thì tạo bài như thường.
    const run = draftId
      ? saveDraft.mutateAsync({ id: draftId, body: draftBody() }).then((d) => publishDraft.mutateAsync({ id: d.id, ...(useQueue ? { use_queue: true } : { scheduled_at: scheduledAt }), expected_updated_at: d.updated_at }))
      : create.mutateAsync({ content, scheduled_at: scheduledAt, ...(useQueue ? { use_queue: true } : {}), media_keys: media.map((m) => m.key), targets: buildTargets(), ...(utmCfg ? { utm: utmCfg } : {}) })
    run.then(
      (p) => {
        toast.success(
          p.scheduled_at
            ? `Đã hẹn đăng bài #${p.id} lúc ${formatDateTime(p.scheduled_at)}`
            : `Đang đăng bài #${p.id} lên các kênh…`,
        )
        setScheduleOn(false)
        setUseQueue(false)
        setScheduleAt("")
        setContent("")
        setSelected([])
        setCaptions({})
        setOpenCaption({})
        setFbFirst({})
        setUtm(EMPTY_UTM_CHOICE)
        setUploads([])
        setDraftId(undefined)
        // Bài mới kế tiếp: điền lại chữ ký mặc định.
        prefilled.current = false
        setRefill((n) => n + 1)
        setStep("edit")
        setTriedNext(false)
        onCreated()
      },
      (err) => toast.error(getApiErrorMessage(err, "Không tạo được bài đăng")),
    )
  }

  // Không tải được kênh ≠ chưa liên kết kênh: nói đúng chuyện + Thử lại.
  if (accountsQ.isError && accounts.length === 0) {
    return (
      <ErrorState
        title="Không tải được danh sách kênh"
        error={accountsQ.error}
        onRetry={() => void accountsQ.refetch()}
        retrying={accountsQ.isFetching}
      />
    )
  }

  if (!isLoading && active.length === 0) {
    return (
      <EmptyState
        variant="ax"
        title="Chưa có kênh nào được liên kết"
        message="Liên kết Fanpage Facebook trước, rồi quay lại soạn bài."
        action={<Button variant="ax-primary" size="ax" onClick={onGoChannels}>Đến mục Kênh</Button>}
      />
    )
  }

  const tooLong = chosen.some((a) => {
    const text = openCaption[a.id] && captions[a.id]?.trim() ? captions[a.id] : content
    // Giới hạn tính SAU khi gắn UTM (liên kết dài ra).
    return withUtm(text, a.network, utmCfg).length > CAPTION_LIMITS[a.network]
  })
  const firstNet = chosen[0]?.network
  const firstText = chosen[0] ? (openCaption[chosen[0].id] && captions[chosen[0].id]?.trim() ? captions[chosen[0].id] : content) : content
  const utmPreview = utmCfg && firstNet ? firstLinkWithUtm(firstText, firstNet, utmCfg) : null
  // Chỉ có chữ ký điền sẵn (chưa gõ gì) thì coi như chưa có nội dung.
  const typed = prefillValue.current !== null && content === prefillValue.current ? "" : content.trim()
  const empty = !typed && media.length === 0
  // Nháp được thiếu mọi thứ — chỉ cần có gì đó để lưu, không bị chặn bởi lỗi kiểm tra.
  const canSaveDraft = !saveDraft.isPending && !uploading && (Boolean(typed) || uploads.some((u) => u.item) || selected.length > 0)
  const schedErr = mode === "schedule" ? scheduleError(scheduleAt) : null
  const recurErr = mode === "recurring" ? recurrenceError(recur) : null
  const queueBlock = mode === "queue" && (noSlots || (nextQ.isSuccess && !nextSlot))
  const disabled = create.isPending || createRecurrence.isPending || saveDraft.isPending || publishDraft.isPending || uploading || chosen.length === 0 || empty || tooLong || Boolean(schedErr) || queueBlock || Boolean(recurErr)

  const whenText =
    mode === "now" ? "Đăng ngay"
    : mode === "queue" ? (nextSlot ? `Hàng đợi · ${queueWhenLabel(nextSlot)}` : "Hàng đợi")
    : mode === "recurring" ? "Lặp lại"
    : scheduleAt && !schedErr ? `Hẹn ${formatDateTime(new Date(scheduleAt).toISOString())}` : "Hẹn giờ"
  const blocker = offline
    ? "Đang mất mạng — chưa gửi được. Bài đang soạn vẫn giữ nguyên."
    : uploading ? "Đang tải tệp lên…"
    : empty ? "Chưa có nội dung."
    : chosen.length === 0 ? "Chưa chọn kênh."
    : tooLong ? "Nội dung vượt giới hạn của kênh."
    : schedErr ?? recurErr ?? (queueBlock ? "Chưa có khung giờ trống." : null)
  const pending = create.isPending || publishDraft.isPending || createRecurrence.isPending
  const primaryLabel = mode === "recurring" ? "Tạo bài lặp lại" : mode === "queue" ? "Thêm vào hàng đợi" : mode === "schedule" ? "Hẹn đăng" : "Đăng ngay"
  const tryNext = () => {
    setTriedNext(true)
    if (empty || chosen.length === 0) return
    setStep("review")
    bodyRef.current?.scrollTo?.({ top: 0 })
  }
  const nextHint = triedNext ? (empty ? "Chưa có nội dung" : chosen.length === 0 ? "Chọn ít nhất một kênh" : null) : null
  const hasWork = Boolean(typed) || uploads.length > 0
  const requestClose = () => {
    if (hasWork) setCloseAsk(true)
    else onClose?.()
  }
  const saveAndClose = () =>
    saveDraft.mutate(
      { id: draftId, body: draftBody() },
      {
        onSuccess: () => {
          toast.success("Đã lưu bài nháp.", { description: "Mở lại ở tab Nháp." })
          setCloseAsk(false)
          onClose?.()
        },
        onError: (err) => toast.error(getApiErrorMessage(err, "Không lưu được bài nháp")),
      },
    )
  const SECTION = "rounded-ax-card border border-ax-line ax-grad-card shadow-ax-card max-lg:rounded-ax-sheet"
  const H2 = "text-[15px] font-semibold tracking-[-0.011em] text-ax-ink max-lg:text-[11px] max-lg:font-semibold max-lg:tracking-[0.06em] max-lg:uppercase max-lg:text-ax-ink-3"
  const edit = step === "edit"

  return (
    <div className="flex flex-col gap-4 max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:gap-0 max-lg:[background:var(--ax-grad-page-mobile)]">
      {/* Điện thoại: màn soạn TOÀN MÀN, hai bước «✕ Bài mới · Tiếp» → «‹ Sửa · Xem lại và đăng» (từ 1024px không hiện). */}
      <div className="flex shrink-0 items-center justify-between border-b border-ax-divider bg-ax-surface px-2 pt-[calc(8px+env(safe-area-inset-top))] pb-1 lg:hidden" data-testid="social-mobile-head">
        {edit ? (
          <>
            <button type="button" aria-label="Đóng, không đăng" onClick={requestClose} className="flex size-11 cursor-pointer items-center justify-center rounded-full text-ax-ink-2 outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
              <X className="size-[22px]" strokeWidth={1.75} aria-hidden />
            </button>
            <h2 className="ax-text-subhead text-ax-ink">Bài mới</h2>
            <Button type="button" variant="ax-ghost" size="ax" onClick={tryNext} className="font-bold text-ax-primary-ink">Tiếp</Button>
          </>
        ) : (
          <>
            <Button type="button" variant="ax-ghost" size="ax" onClick={() => { setStep("edit"); bodyRef.current?.scrollTo?.({ top: 0 }) }} aria-label="Quay lại sửa bài" className="-ml-1 text-ax-primary">
              <ChevronLeft className="size-5" aria-hidden /> Sửa
            </Button>
            <h2 className="ax-text-subhead text-ax-ink">Xem lại và đăng</h2>
            <span aria-hidden className="w-16" />
          </>
        )}
      </div>

      <div ref={bodyRef} className="max-lg:min-h-0 max-lg:flex-1 max-lg:overflow-y-auto max-lg:px-4 max-lg:pt-3.5 max-lg:pb-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-label="Nội dung bài" className={cn("flex flex-col gap-3.5 lg:rounded-ax-card lg:border lg:border-ax-line lg:ax-grad-composer lg:px-6 lg:py-[22px] lg:shadow-ax-card lg:focus-within:shadow-[var(--ax-field-focus)]", !edit && "max-lg:hidden")}>
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Viết nội dung bài đăng. Xuống dòng, link và hashtag giữ nguyên." rows={8} className="min-h-48 resize-none border-0 bg-transparent p-0 text-base leading-[1.6] text-ax-ink shadow-none placeholder:text-[var(--ax-placeholder)] focus-visible:ring-0 max-lg:order-1 max-lg:min-h-44 max-lg:rounded-ax-sheet max-lg:border max-lg:border-ax-line max-lg:ax-grad-composer max-lg:p-4 max-lg:text-[17px] max-lg:leading-[1.55] max-lg:shadow-ax-card max-lg:focus-visible:shadow-[var(--ax-field-focus)]" aria-label="Nội dung bài đăng" />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ax-divider pt-3.5 max-lg:order-3 max-lg:border-0 max-lg:pt-0">
              <div className="flex flex-wrap gap-2">
                <label className={cn(buttonVariants({ variant: "ax-secondary", size: "ax" }), "cursor-pointer focus-within:shadow-[var(--ax-focus-ring)] max-lg:hidden")}>
                  <ImagePlus className="size-4 text-ax-primary" aria-hidden /> Thêm ảnh / video
                  <input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = "" }} />
                </label>
                <Button type="button" variant="ax-secondary" size="ax" onClick={() => setLibOpen(true)}>
                  <Images className="size-4 text-ax-primary" aria-hidden /> Chọn từ thư viện
                </Button>
                <SnippetMenu onInsert={(c) => setContent((x) => insertSnippet(x, c))} onManage={() => setSnippetsOpen(true)} />
              </div>
              <div className="text-[13px] tabular-nums"><Counter text={content} limit={Math.min(...(chosen.length ? chosen.map((a) => CAPTION_LIMITS[a.network]) : [CAPTION_LIMITS.facebook]))} /></div>
            </div>
            <SocialSnippetsDialog open={snippetsOpen} onOpenChange={setSnippetsOpen} />
            <Dialog open={libOpen} onOpenChange={setLibOpen}>
              <DialogContent className="sm:max-w-4xl">
                <DialogHeader>
                  <DialogTitle>Chọn từ thư viện</DialogTitle>
                  <DialogDescription>Bấm vào ảnh/video để thêm vào bài, bấm lần nữa để bỏ.</DialogDescription>
                </DialogHeader>
                <div className="max-h-[60vh] overflow-y-auto pr-1">
                  <SocialLibrary pick={{ selected: pickedKeys, onToggle: togglePick }} />
                </div>
                <DialogFooter>
                  <Button type="button" variant="ax-primary" size="ax" onClick={() => setLibOpen(false)}>Xong{pickedKeys.length ? ` (${pickedKeys.length} tệp)` : ""}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {/* Điện thoại: hàng ô vuông 84px + ô «Ảnh» nét đứt (cuộn ngang); desktop: thẻ nhỏ trong khung soạn. */}
            <ul className={cn("flex flex-wrap gap-2.5 max-lg:order-2 max-lg:flex-nowrap max-lg:gap-2 max-lg:overflow-x-auto max-lg:pb-0.5", uploads.length === 0 && "lg:hidden")}>
              {uploads.map((u) => (
                <li key={u.id} className="relative flex min-h-24 w-28 flex-col justify-end gap-0.5 rounded-ax-field bg-ax-primary-soft p-2 text-[12px] font-semibold text-ax-primary-ink max-lg:size-[84px] max-lg:min-h-0 max-lg:w-[84px] max-lg:shrink-0">
                  <span className="truncate" title={u.name}>{u.name}</span>
                  {u.error ? <span className="font-normal text-[var(--ax-danger-ink)]">{u.error}</span> : u.item ? <span className="font-normal text-ax-ink-2">{u.item.type === "video" ? "video" : "ảnh"}</span> : <span className="font-normal text-ax-ink-2 tabular-nums">{u.pct}%</span>}
                  <button type="button" aria-label={`Bỏ ${u.name}`} className="absolute top-0 right-0 flex size-11 cursor-pointer items-start justify-end p-1.5 outline-none focus-visible:[&>span]:shadow-[var(--ax-focus-ring)]" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                    <span className="flex size-7 items-center justify-center rounded-full bg-ax-surface"><X className="size-3 text-ax-ink-2" aria-hidden /></span>
                  </button>
                </li>
              ))}
              <li className="size-[84px] shrink-0 lg:hidden">
                <label className="flex size-full cursor-pointer flex-col items-center justify-center gap-1 rounded-ax-field border-[1.5px] border-dashed border-ax-field-border bg-ax-surface text-[12px] font-semibold text-ax-primary focus-within:shadow-[var(--ax-focus-ring)]">
                  <ImagePlus className="size-[22px]" strokeWidth={1.75} aria-hidden />
                  Ảnh
                  <input type="file" multiple accept={ACCEPT} aria-label="Thêm ảnh hoặc video" className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = "" }} />
                </label>
              </li>
            </ul>
          </section>

          <section aria-label="Kênh đăng" className={cn(SECTION, "flex flex-col gap-3 px-6 py-5 max-lg:border-0 max-lg:bg-transparent max-lg:p-0 max-lg:shadow-none max-lg:[background:none]", !edit && "max-lg:hidden")}>
            <div className="flex items-baseline justify-between gap-2">
              <h2 className={H2}>Đăng lên</h2>
              <div className="flex items-center gap-3 text-[13px] text-ax-ink-3">
                <span>{chosen.length} kênh đã chọn</span>
                {active.length > 1 && (
                  <button type="button" className="relative cursor-pointer rounded font-semibold text-ax-primary outline-none hover:text-ax-primary-hover focus-visible:shadow-[var(--ax-focus-ring)] after:absolute after:-inset-x-1 after:top-1/2 after:h-11 after:-translate-y-1/2"
                    onClick={() => setSelected(chosen.length === active.length ? [] : active.map((a) => a.id))}>
                    {chosen.length === active.length ? "Bỏ chọn" : "Chọn tất cả"}
                  </button>
                )}
              </div>
            </div>
            {isLoading && <Loader2 className="size-4 animate-spin text-ax-ink-3" aria-label="Đang tải kênh" />}
            <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:gap-2.5">
              {accounts.map((a) => (
                <label key={a.id} className={cn(
                  "relative flex min-h-14 cursor-pointer items-center gap-3 rounded-ax-field border-[1.5px] border-ax-line bg-ax-surface py-1.5 pr-3.5 pl-2 transition-colors duration-150 hover:bg-ax-hover lg:min-h-[52px] lg:gap-2.5",
                  "has-checked:border-ax-primary has-checked:bg-ax-primary-soft has-focus-visible:shadow-[var(--ax-focus-ring)] has-disabled:cursor-not-allowed has-disabled:opacity-60",
                )}>
                  <input type="checkbox" className="peer sr-only" checked={selected.includes(a.id)} disabled={a.status !== "active"} onChange={() => toggle(a)} />
                  <NetworkMark network={a.network} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-base font-semibold text-ax-ink lg:text-sm">{a.name}</span>
                    <span className="text-[13px] text-ax-ink-2 lg:text-[12px]">{a.status !== "active" ? "Cần liên kết lại ở mục Kênh" : NETWORK_META[a.network]?.label ?? a.network}</span>
                  </span>
                  <span aria-hidden className="ml-1.5 flex size-5 shrink-0 items-center justify-center rounded-md border-[1.5px] border-ax-field-border bg-ax-surface peer-checked:border-ax-primary peer-checked:bg-ax-primary peer-checked:[&>svg]:opacity-100 max-lg:size-6 max-lg:rounded-full">
                    <Check className="size-3 text-white opacity-0 lg:size-3" strokeWidth={3.4} />
                  </span>
                </label>
              ))}
            </div>
            {accounts.filter((a) => a.status !== "active").map((a) => (
              <p key={a.id} className="text-[13px] text-ax-warn">{a.name}: kênh {STATUS_LABEL.reauth.toLowerCase()} — vào tab Kênh để kết nối lại</p>
            ))}
            {chosen.length > 0 && (
              <div className="flex flex-col gap-3 border-t border-ax-divider pt-3">
                {chosen.map((a) => {
                  const own = Boolean(openCaption[a.id])
                  const text = own ? captions[a.id] ?? "" : content
                  return (
                    <div key={a.id} className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm text-ax-ink-2">{a.name}: <span className="text-ax-ink-3">{own ? "nội dung riêng" : "dùng nội dung chung"}</span></span>
                        <Button type="button" variant="ax-ghost" size="ax" className="shrink-0 text-ax-primary" onClick={() => {
                          setOpenCaption((o) => ({ ...o, [a.id]: !o[a.id] }))
                          setCaptions((c) => ({ ...c, [a.id]: c[a.id] ?? content }))
                        }}>
                          {own ? "Dùng nội dung chung" : "Sửa nội dung riêng cho kênh này"}
                        </Button>
                      </div>
                      {own && (
                        <Textarea rows={4} value={captions[a.id] ?? ""} onChange={(e) => setCaptions((c) => ({ ...c, [a.id]: e.target.value }))} aria-label={`Nội dung riêng cho ${a.name}`} className={cn(AX_INPUT_CLASS, "h-auto max-sm:h-auto pointer-coarse:h-auto py-2.5 leading-normal")} />
                      )}
                      <div className="text-right text-[13px] tabular-nums"><Counter text={withUtm(text, a.network, utmCfg)} limit={CAPTION_LIMITS[a.network]} /></div>
                      {a.network === "facebook" && (
                        <div className="space-y-1">
                          <Textarea rows={2} maxLength={8000} value={fbFirst[a.id] ?? ""} placeholder="Bình luận đầu tiên (tuỳ chọn) — vd link mua hàng, hashtag" aria-label={`Bình luận đầu tiên trên ${a.name}`}
                            onChange={(e) => setFbFirst((x) => ({ ...x, [a.id]: e.target.value }))} className={cn(AX_INPUT_CLASS, "h-auto max-sm:h-auto pointer-coarse:h-auto py-2.5 leading-normal")} />
                          <p className="text-[13px] text-ax-ink-2">Fanpage tự bình luận ngay dưới bài vừa đăng. Cần kết nối Fanpage này ở Cài đặt › Kết nối › Fanpage Facebook.</p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section aria-label="Thời điểm đăng" className={cn(SECTION, "flex flex-col gap-3.5 px-6 py-5 max-lg:p-0 max-lg:overflow-hidden", edit && "max-lg:hidden")}>
            <h2 className={cn(H2, "max-lg:sr-only")}>Khi nào đăng</h2>
            <div role="radiogroup" aria-label="Thời điểm đăng" className="grid grid-cols-2 gap-2 xl:grid-cols-4 max-lg:grid-cols-1 max-lg:gap-0 max-lg:divide-y max-lg:divide-ax-divider">
              {([
                ["now", "Đăng ngay", chosen.length > 0 ? `Lên ${chosen.length} kênh trong ít giây` : "Lên kênh trong ít giây"],
                ["schedule", "Hẹn giờ", scheduleAt && !schedErr ? formatDateTime(new Date(scheduleAt).toISOString()) : "Chọn ngày và giờ"],
                ["queue", "Vào hàng đợi", nextSlot ? `Gần nhất ${queueWhenLabel(nextSlot)}` : "Tự lấy khung trống"],
                ["recurring", "Lặp lại", "Tự đăng theo lịch"],
              ] as const).map(([m, label, sub]) => {
                const off = m === "queue" && noSlots
                return (
                  <div key={m} className={cn(
                    "relative flex min-h-16 flex-col justify-center gap-0.5 rounded-ax-field border-[1.5px] border-ax-line bg-ax-surface px-3.5 py-2.5 transition-colors duration-150 hover:bg-ax-hover",
                    "has-checked:border-ax-primary has-checked:ax-grad-soft has-focus-visible:shadow-[var(--ax-focus-ring)]",
                    "max-lg:min-h-14 max-lg:flex-row max-lg:items-center max-lg:gap-3 max-lg:rounded-none max-lg:border-0 max-lg:px-4 max-lg:py-0",
                    off && "cursor-not-allowed opacity-60",
                  )}>
                    <label className={cn("flex items-center gap-3 text-sm font-semibold text-ax-ink after:absolute after:inset-0 max-lg:text-base max-lg:font-medium", off ? "cursor-not-allowed" : "cursor-pointer", mode === m && "text-ax-primary-ink")}>
                      <input type="radio" name="social-when" value={m} checked={mode === m} disabled={off} onChange={() => pickMode(m)} className="size-4 shrink-0 accent-[var(--ax-primary)] max-lg:size-[22px]" />
                      {label}
                    </label>
                    <span className="pointer-events-none pl-7 text-[12px] text-ax-ink-2 max-lg:ml-auto max-lg:pl-0 max-lg:text-right max-lg:text-[13px] max-lg:text-ax-ink-3">{sub}</span>
                  </div>
                )
              })}
            </div>
            {noSlots && (
              <p className="text-[13px] text-ax-ink-2 max-lg:px-4" data-testid="queue-hint">
                Chưa có khung giờ hàng đợi.{" "}
                {onGoCalendar ? <button type="button" className="cursor-pointer font-semibold text-ax-primary hover:underline" onClick={onGoCalendar}>Đặt khung giờ ở tab Lịch</button> : "Đặt khung giờ ở tab Lịch."}
              </p>
            )}
            {mode === "queue" && !noSlots && (
              <p className="ax-sunken px-3.5 py-3 text-sm text-ax-ink-2 max-lg:mx-4 max-lg:mb-4" data-testid="queue-next">
                {nextQ.isLoading ? "Đang tìm khung trống…" : nextSlot ? `Khung trống gần nhất: ${queueWhenLabel(nextSlot)}` : "Không còn khung trống trong 90 ngày tới."}
              </p>
            )}
            {mode === "recurring" && <div className="max-lg:px-4 max-lg:pb-4"><RecurrenceFields value={recur} onChange={setRecur} /></div>}
            {mode === "schedule" && (
              <div className="space-y-1.5 max-lg:px-4 max-lg:pb-4">
                <div className="flex gap-2.5">
                  <div className="flex-[1.3]">
                    <label htmlFor="social-sched-date" className="mb-1.5 block text-[13px] font-semibold text-ax-ink-2">Ngày</label>
                    <Input
                      id="social-sched-date"
                      type="date"
                      variant="ax"
                      value={scheduleAt.slice(0, 10)}
                      min={toLocalInput(new Date(Date.now() + 2 * 60_000)).slice(0, 10)}
                      max={toLocalInput(new Date(Date.now() + MAX_SCHEDULE_AHEAD_MS)).slice(0, 10)}
                      onChange={(e) => setScheduleAt(e.target.value ? `${e.target.value}T${scheduleAt.slice(11, 16) || "09:00"}` : "")}
                      aria-label="Ngày đăng"
                      aria-invalid={Boolean(schedErr) || undefined}
                      className="w-auto max-lg:w-full"
                    />
                  </div>
                  <div className="flex-1">
                    <label htmlFor="social-sched-time" className="mb-1.5 block text-[13px] font-semibold text-ax-ink-2">Giờ</label>
                    <Input
                      id="social-sched-time"
                      type="time"
                      variant="ax"
                      value={scheduleAt.slice(11, 16)}
                      onChange={(e) => setScheduleAt(`${scheduleAt.slice(0, 10) || toLocalInput(new Date()).slice(0, 10)}T${e.target.value || "00:00"}`)}
                      aria-label="Giờ đăng"
                      aria-invalid={Boolean(schedErr) || undefined}
                      className="w-auto max-lg:w-full"
                    />
                  </div>
                </div>
                {schedErr ? <p className="text-[13px] text-[var(--ax-danger-ink)]">{schedErr}</p> : <p className="text-[13px] text-ax-ink-2">Bài sẽ tự đăng đúng giờ này. Có thể huỷ trong danh sách bài trước giờ đăng.</p>}
              </div>
            )}
          </section>

          <section aria-label="Gắn UTM" className={cn(SECTION, "space-y-2 px-6 py-4 max-lg:px-4", edit && "max-lg:hidden")}>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ax-ink max-sm:min-h-11">
              <Checkbox checked={utm.on} onChange={(e) => setUtm((u) => ({ ...u, on: e.target.checked }))} aria-label="Gắn UTM vào liên kết" />
              Gắn UTM vào liên kết
            </label>
            {utm.on && (
              <div className="space-y-2 pl-6">
                <Input
                  variant="ax"
                  value={utm.campaign}
                  maxLength={100}
                  placeholder={defaultCampaign(content)}
                  onChange={(e) => setUtm((u) => ({ ...u, campaign: e.target.value }))}
                  aria-label="Tên chiến dịch (utm_campaign)"
                  className="max-w-sm"
                />
                <details className="text-[13px] text-ax-ink-2">
                  <summary className="cursor-pointer select-none">Nâng cao</summary>
                  <Input
                    variant="ax"
                    value={utm.content}
                    maxLength={100}
                    placeholder="utm_content (tuỳ chọn)"
                    onChange={(e) => setUtm((u) => ({ ...u, content: e.target.value }))}
                    aria-label="utm_content"
                    className="mt-2 max-w-sm"
                  />
                </details>
                <p className="break-all text-[13px] text-ax-ink-2" data-testid="utm-preview">
                  {!firstNet
                    ? "Chọn kênh để xem liên kết sau khi gắn UTM."
                    : utmPreview
                      ? `Liên kết đầu tiên: ${utmPreview}`
                      : "Nội dung chưa có liên kết http(s) nên UTM chưa có tác dụng."}
                </p>
                <p className="text-[13px] text-ax-ink-2">utm_source là tên mạng, utm_medium=social. Liên kết đã có utm_ giữ nguyên; nội dung lưu trong bài vẫn sạch.</p>
              </div>
            )}
          </section>
        </div>

        {/* Xem trước: desktop = cột phải dính; điện thoại = đầu bước «Xem lại và đăng». */}
        <aside aria-label="Xem trước" className={cn("flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 max-lg:order-first", edit && "max-lg:hidden")}>
          <div className={cn(SECTION, "flex flex-col gap-3.5 px-5 py-[18px] max-lg:gap-2.5 max-lg:border-0 max-lg:p-0 max-lg:shadow-none max-lg:[background:none]")}>
            <div className="flex items-baseline justify-between gap-2 max-lg:sr-only">
              <h2 className="text-[15px] font-semibold tracking-[-0.011em] text-ax-ink">Xem trước</h2>
              <span className="text-[12px] text-ax-ink-3 tabular-nums">{whenText}</span>
            </div>
            {chosen.length > 0 ? (
              <SocialPreviewPanel
                libIds={Object.fromEntries(uploads.flatMap((u) => (u.item ? [[u.item.key, u.libId] as const] : [])))}
                body={{
                  content,
                  media_keys: media.map((m) => m.key),
                  targets: buildTargets(),
                  ...(useQueue ? { use_queue: true } : scheduleOn && !schedErr ? { scheduled_at: new Date(scheduleAt).toISOString() } : {}),
                  ...(utmCfg ? { utm: utmCfg } : {}),
                }}
              />
            ) : (
              <EmptyState variant="ax" message="Chọn ít nhất một kênh để xem trước. Điểm “Xem thêm” là ước lượng, Facebook hiển thị khác nhau tuỳ thiết bị." />
            )}
          </div>
        </aside>
      </div>
      </div>

      {/* Thanh hành động = MỘT khối nhấn của màn. Desktop: nổi, tóm tắt + Lưu nháp + nút chính. Điện thoại: đáy màn,
          bước 1 chỉ tóm tắt «N kênh · số ký tự», bước 2 nút chính + «Lưu nháp, đăng sau».
          Dưới 1024px cả màn là lớp toàn màn (fixed) nên thanh là phần tử cuối của cột flex; từ 1024px thanh `sticky`
          dính đáy khung nhìn (khung `main` được thả `overflow` ở layout khi có thanh này). */}
      <div
        data-slot="social-action-bar"
        className="ax-grad-hero text-[var(--ax-on-hero-ink)] border border-[var(--ax-hero-border)] shadow-[var(--ax-shadow-hero)] max-lg:shrink-0 max-lg:rounded-t-[22px] max-lg:border-x-0 max-lg:border-b-0 max-lg:px-5 max-lg:pt-4 max-lg:pb-[calc(16px+env(safe-area-inset-bottom))] lg:sticky lg:bottom-3 lg:z-30 lg:rounded-2xl lg:py-3 lg:pr-3 lg:pl-5"
      >
        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between lg:gap-3">
          <div className="min-w-0 text-white">
            <p className="text-[15px] font-semibold tracking-[-0.011em] tabular-nums max-lg:hidden" aria-live="polite">
              {chosen.length} kênh · {whenText}
              {blocker && <span role="status" className="ml-2 text-[13px] font-medium text-[#FFDFA6]">{blocker}</span>}
            </p>
            {edit && (
              <p className="text-base font-semibold tracking-[-0.011em] tabular-nums lg:hidden">
                {chosen.length} kênh · {content.length.toLocaleString("vi-VN")} ký tự
                {nextHint && <span role="status" className="ml-2 text-[13px] font-medium text-[#FFDFA6]">{nextHint}</span>}
              </p>
            )}
            {!edit && blocker && <p role="status" className="text-[13px] font-medium text-[#FFDFA6] lg:hidden">{blocker}</p>}
          </div>
          <div className={cn("flex flex-col-reverse gap-2 lg:flex-row", edit && "max-lg:hidden")}>
            <Button type="button" variant="ax-on-hero-secondary" size="ax-lg" onClick={saveAsDraft} disabled={!canSaveDraft || offline}>
              {saveDraft.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              <span className="lg:hidden">Lưu nháp, đăng sau</span><span className="max-lg:hidden">Lưu nháp</span>
            </Button>
            <Button type="button" variant="ax-on-hero" size="ax-lg" onClick={submit} disabled={disabled || offline} className="lg:min-w-36">
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {primaryLabel}
            </Button>
          </div>
        </div>
      </div>
      <Dialog open={closeAsk} onOpenChange={setCloseAsk}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bỏ bài đang soạn?</DialogTitle>
            <DialogDescription>Lưu nháp để mở lại ở tab Nháp, hoặc bỏ bài này.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="max-sm:flex-col-reverse">
            <Button type="button" variant="ax-secondary" size="ax" onClick={() => { setCloseAsk(false); onClose?.() }}>Bỏ bài</Button>
            <Button type="button" variant="ax-secondary" size="ax" onClick={() => setCloseAsk(false)}>Tiếp tục soạn</Button>
            <Button type="button" variant="ax-primary" size="ax" onClick={saveAndClose} disabled={!canSaveDraft || offline}>Lưu nháp rồi đóng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
