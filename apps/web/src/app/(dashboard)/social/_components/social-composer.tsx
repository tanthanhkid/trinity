"use client"

import { useEffect, useRef, useState } from "react"
import { CalendarClock, ImagePlus, Images, ListPlus, Loader2, Repeat, Save, Send, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
  useTiktokCreatorInfos,
  type SocialAccount,
  type SocialDraft,
  type SocialLibraryItem,
  type SocialMediaItem,
} from "@/hooks/use-social"
import apiClient from "@/lib/api-client"
import { SocialLibrary } from "./social-library"
import { SocialPreviewPanel } from "./social-preview"
import { queueWhenLabel } from "./social-queue"
import { SnippetMenu, SocialSnippetsDialog, insertSnippet, signaturePrefill } from "./social-snippets"
import { EMPTY_UTM_CHOICE, defaultCampaign, firstLinkWithUtm, utmPayload, withUtm, type UtmChoice } from "./social-utm"
import { composerStateFrom, type ComposerState } from "./social-draft-state"
import { RecurrenceFields } from "./social-recurrence"
import { emptyRecurrence, recurrenceError, recurrenceSchedule } from "./social-recurrence-rules"
import { todayVn } from "@/lib/format"
import { EMPTY_YOUTUBE_CHOICE, YoutubePostOptions, youtubeOptionsOf, type YoutubeChoice } from "./youtube-post-options"
import { EMPTY_TIKTOK_CHOICE, TIKTOK_BRANDED_URL, TIKTOK_MUSIC_URL, TiktokPostOptions, tiktokBlocker, tiktokOptionsOf, type TiktokChoice } from "./tiktok-post-options"

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.mov"

interface Upload {
  id: string
  name: string
  pct: number
  item?: SocialMediaItem
  error?: string
  /** Nguồn để đo thời lượng video (TikTok giới hạn theo tài khoản). */
  file?: File
  libId?: number
}

/** Thời lượng video (giây) đọc từ metadata; null = trình duyệt không đọc được. */
function measureVideo(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video")
    v.preload = "metadata"
    const done = (d: number | null) => {
      v.removeAttribute("src")
      v.load()
      resolve(d)
    }
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null)
    v.onerror = () => done(null)
    v.src = src
  })
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
  return <span className={over ? "text-destructive" : "text-muted-foreground"}>{text.length.toLocaleString("vi-VN")}/{limit.toLocaleString("vi-VN")}</span>
}

/** Soạn một lần, chọn kênh, sửa nội dung riêng từng kênh, đăng ngay. */
export function SocialComposer({ onCreated, onGoChannels, onGoCalendar, preset, draft }: { onCreated: (kind?: "recurring") => void; onGoChannels: () => void; onGoCalendar?: () => void; preset?: { at: string; n: number }; draft?: SocialDraft }) {
  const { data: accounts = [], isLoading } = useSocialAccounts()
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
  const [ytChoice, setYtChoice] = useState<Record<number, YoutubeChoice>>(init?.ytChoice ?? {})
  const [fbFirst, setFbFirst] = useState<Record<number, string>>(init?.fbFirst ?? {})
  const [ttChoice, setTtChoice] = useState<Record<number, TiktokChoice>>(init?.ttChoice ?? {})
  /** Thời lượng video theo media key: undefined = chưa đo xong, null = không đọc được. */
  const [durations, setDurations] = useState<Record<string, number | null>>({})
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
  /** Cột phải: danh sách kênh hoặc bản xem trước theo kênh. */
  const [side, setSide] = useState<"channels" | "preview">("channels")
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
      setUploads((u) => [...u, { id, name: file.name, pct: 0, file }])
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

  // Đo thời lượng mỗi video đính kèm một lần (tệp tải lên: đọc thẳng tệp; tệp thư viện: tải qua BE).
  const tiktokChosen = chosen.filter((a) => a.network === "tiktok")
  const videoUpload = uploads.find((u) => u.item?.type === "video")
  const videoKey = videoUpload?.item?.key
  useEffect(() => {
    if (!videoUpload || !videoKey || tiktokChosen.length === 0 || videoKey in durations) return
    let cancelled = false
    const run = async () => {
      let url: string | null = null
      try {
        url = videoUpload.file
          ? URL.createObjectURL(videoUpload.file)
          : videoUpload.libId
            ? URL.createObjectURL((await apiClient.get<Blob>(`/social/media/${videoUpload.libId}/file`, { responseType: "blob" })).data)
            : null
        const d = url ? await measureVideo(url) : null
        if (!cancelled) setDurations((x) => ({ ...x, [videoKey]: d }))
      } catch {
        if (!cancelled) setDurations((x) => ({ ...x, [videoKey]: null }))
      } finally {
        if (url) URL.revokeObjectURL(url)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- đo lại khi đổi video hoặc khi vừa chọn kênh TikTok
  }, [videoKey, tiktokChosen.length > 0])
  const videoDuration = videoKey ? durations[videoKey] : null
  const ttInfo = useTiktokCreatorInfos(tiktokChosen.map((a) => a.id))
  const ttBlock = tiktokChosen.map((a) => tiktokBlocker(ttChoice[a.id] ?? EMPTY_TIKTOK_CHOICE, ttInfo[a.id], videoDuration)).find(Boolean) ?? null
  const ttBranded = tiktokChosen.some((a) => {
    const c = ttChoice[a.id]
    return c?.commercial && c.brandContent
  })

  const toggle = (a: SocialAccount) => setSelected((s) => (s.includes(a.id) ? s.filter((x) => x !== a.id) : [...s, a.id]))

  const utmCfg = utmPayload(utm, content)

  /** Kênh đã chọn + nội dung riêng + tuỳ chọn từng mạng — dùng chung cho đăng và lưu nháp. */
  const buildTargets = () =>
    chosen.map((a) => ({
      account_id: a.id,
      caption: openCaption[a.id] && captions[a.id]?.trim() ? captions[a.id] : null,
      options:
        a.network === "youtube"
          ? youtubeOptionsOf(ytChoice[a.id] ?? EMPTY_YOUTUBE_CHOICE)
          : a.network === "tiktok"
            ? tiktokOptionsOf(ttChoice[a.id] ?? EMPTY_TIKTOK_CHOICE, ttInfo[a.id], videoDuration)
            : a.network === "facebook" && fbFirst[a.id]?.trim()
              ? { first_comment: fbFirst[a.id].trim() }
              : undefined,
    }))

  /** Toàn bộ trạng thái ô soạn ⇒ thân nháp (dùng cho Lưu nháp và trước khi đăng nháp đang mở). */
  const draftBody = () => {
    const at = scheduleOn && !useQueue && scheduleAt ? new Date(scheduleAt) : null
    const ui: ComposerState = {
      content, selected, captions, openCaption, ytChoice, fbFirst, ttChoice, scheduleOn, scheduleAt, useQueue, utm, recurOn, recur,
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
        setYtChoice({})
        setFbFirst({})
        setTtChoice({})
        setUtm(EMPTY_UTM_CHOICE)
        setUploads([])
        setRecur(emptyRecurrence(todayVn()))
        prefilled.current = false
        setRefill((n) => n + 1)
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
            ? `Đã hẹn đăng bài #${p.id} lúc ${new Date(p.scheduled_at).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" })}`
            : `Đang đăng bài #${p.id} lên các kênh…`,
          tiktokChosen.length ? { description: "TikTok cần vài phút để xử lý video trước khi video hiện trên hồ sơ." } : undefined,
        )
        setScheduleOn(false)
        setUseQueue(false)
        setScheduleAt("")
        setContent("")
        setSelected([])
        setCaptions({})
        setOpenCaption({})
        setYtChoice({})
        setFbFirst({})
        setTtChoice({})
        setUtm(EMPTY_UTM_CHOICE)
        setUploads([])
        setDraftId(undefined)
        // Bài mới kế tiếp: điền lại chữ ký mặc định.
        prefilled.current = false
        setRefill((n) => n + 1)
        onCreated()
      },
      (err) => toast.error(getApiErrorMessage(err, "Không tạo được bài đăng")),
    )
  }

  if (!isLoading && active.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6 text-sm">
          <p>Chưa có kênh nào được liên kết. Liên kết Fanpage Facebook hoặc kênh YouTube trước, rồi quay lại soạn bài.</p>
          <Button variant="outline" onClick={onGoChannels}>Đến mục Kênh</Button>
        </CardContent>
      </Card>
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
  const disabled = create.isPending || createRecurrence.isPending || saveDraft.isPending || publishDraft.isPending || uploading || chosen.length === 0 || empty || tooLong || Boolean(schedErr) || queueBlock || Boolean(ttBlock) || Boolean(recurErr)

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Viết nội dung bài đăng…" rows={8} className="min-h-48 text-[15px] leading-6" aria-label="Nội dung bài đăng" />
            <div className="text-right text-xs"><Counter text={content} limit={Math.min(...(chosen.length ? chosen.map((a) => CAPTION_LIMITS[a.network]) : [CAPTION_LIMITS.facebook]))} /></div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <label className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer focus-within:ring-[3px] focus-within:ring-ring/20")}>
                <ImagePlus className="size-4" /> Thêm ảnh / video
                <input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = "" }} />
              </label>
              <Button type="button" variant="outline" onClick={() => setLibOpen(true)}>
                <Images className="size-4" /> Chọn từ thư viện
              </Button>
              <SnippetMenu onInsert={(c) => setContent((x) => insertSnippet(x, c))} onManage={() => setSnippetsOpen(true)} />
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
                  <Button type="button" onClick={() => setLibOpen(false)}>Xong{pickedKeys.length ? ` (${pickedKeys.length} tệp)` : ""}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            {uploads.length > 0 && (
              <ul className="space-y-1 text-sm">
                {uploads.map((u) => (
                  <li key={u.id} className="flex items-center gap-2">
                    <span className="truncate">{u.name}</span>
                    {u.error ? <span className="text-destructive">{u.error}</span> : u.item ? <span className="text-muted-foreground">{u.item.type === "video" ? "video" : "ảnh"}</span> : <span className="text-muted-foreground">{u.pct}%</span>}
                    <button type="button" aria-label={`Bỏ ${u.name}`} className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <div role="radiogroup" aria-label="Thời điểm đăng" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {([["now", "Đăng ngay"], ["schedule", "Hẹn giờ"], ["queue", "Vào hàng đợi"], ["recurring", "Lặp lại"]] as const).map(([m, label]) => {
                const off = m === "queue" && noSlots
                return (
                  <label key={m} className={cn("flex items-center gap-1.5", off ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
                    <input type="radio" name="social-when" value={m} checked={mode === m} disabled={off} onChange={() => pickMode(m)} className="size-4 accent-primary" />
                    {label}
                  </label>
                )
              })}
            </div>
            {noSlots && (
              <p className="text-xs text-muted-foreground" data-testid="queue-hint">
                Chưa có khung giờ hàng đợi.{" "}
                {onGoCalendar ? <button type="button" className="text-primary hover:underline" onClick={onGoCalendar}>Đặt khung giờ ở tab Lịch</button> : "Đặt khung giờ ở tab Lịch."}
              </p>
            )}
            {mode === "queue" && !noSlots && (
              <p className="text-xs text-muted-foreground" data-testid="queue-next">
                {nextQ.isLoading ? "Đang tìm khung trống…" : nextSlot ? `Khung trống gần nhất: ${queueWhenLabel(nextSlot)}` : "Không còn khung trống trong 90 ngày tới."}
              </p>
            )}
            {mode === "recurring" && <RecurrenceFields value={recur} onChange={setRecur} />}
            {mode === "schedule" && (
              <div className="space-y-1">
                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  min={toLocalInput(new Date(Date.now() + 2 * 60_000))}
                  max={toLocalInput(new Date(Date.now() + MAX_SCHEDULE_AHEAD_MS))}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  aria-label="Ngày giờ đăng"
                  className="w-auto"
                />
                {schedErr ? <p className="text-xs text-destructive">{schedErr}</p> : <p className="text-xs text-muted-foreground">Bài sẽ tự đăng đúng giờ này. Có thể huỷ trong danh sách bài trước giờ đăng.</p>}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={utm.on} onChange={(e) => setUtm((u) => ({ ...u, on: e.target.checked }))} aria-label="Gắn UTM vào liên kết" />
              Gắn UTM vào liên kết
            </label>
            {utm.on && (
              <div className="space-y-2 pl-6">
                <Input
                  value={utm.campaign}
                  maxLength={100}
                  placeholder={defaultCampaign(content)}
                  onChange={(e) => setUtm((u) => ({ ...u, campaign: e.target.value }))}
                  aria-label="Tên chiến dịch (utm_campaign)"
                  className="max-w-sm"
                />
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none">Nâng cao</summary>
                  <Input
                    value={utm.content}
                    maxLength={100}
                    placeholder="utm_content (tuỳ chọn)"
                    onChange={(e) => setUtm((u) => ({ ...u, content: e.target.value }))}
                    aria-label="utm_content"
                    className="mt-2 max-w-sm"
                  />
                </details>
                <p className="break-all text-xs text-muted-foreground" data-testid="utm-preview">
                  {!firstNet
                    ? "Chọn kênh để xem liên kết sau khi gắn UTM."
                    : utmPreview
                      ? `Liên kết đầu tiên: ${utmPreview}`
                      : "Nội dung chưa có liên kết http(s) nên UTM chưa có tác dụng."}
                </p>
                <p className="text-xs text-muted-foreground">utm_source là tên mạng, utm_medium=social. Liên kết đã có utm_ giữ nguyên; nội dung lưu trong bài vẫn sạch.</p>
              </div>
            )}
          </div>

          {tiktokChosen.length > 0 && (
            <div className="space-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
              {ttBlock && <p className="text-destructive">TikTok: {ttBlock}</p>}
              <p>
                Khi đăng lên TikTok, bạn đồng ý với{" "}
                {ttBranded && (
                  <>
                    <a href={TIKTOK_BRANDED_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">Chính sách nội dung có thương hiệu</a> và{" "}
                  </>
                )}
                <a href={TIKTOK_MUSIC_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">Xác nhận sử dụng âm nhạc (Music Usage Confirmation)</a> của TikTok.
              </p>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-muted-foreground">
              {chosen.length === 0 ? "Chọn ít nhất một kênh ở bên cạnh." : `Sẽ đăng lên ${chosen.map((a) => a.name).join(", ")}.`}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={saveAsDraft} disabled={!canSaveDraft} className="max-sm:w-full">
              {saveDraft.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Lưu nháp
            </Button>
            <Button onClick={submit} disabled={disabled} className="max-sm:w-full">
              {create.isPending || publishDraft.isPending || createRecurrence.isPending ? <Loader2 className="size-4 animate-spin" /> : mode === "recurring" ? <Repeat className="size-4" /> : mode === "queue" ? <ListPlus className="size-4" /> : mode === "schedule" ? <CalendarClock className="size-4" /> : <Send className="size-4" />}
              {mode === "recurring" ? "Tạo bài lặp lại" : mode === "queue" ? "Thêm vào hàng đợi" : mode === "schedule" ? "Hẹn đăng" : "Đăng ngay"}{chosen.length > 0 ? ` (${chosen.length} kênh)` : ""}
            </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="self-start">
        <CardContent className="flex flex-col gap-3 p-4">
          <div role="tablist" aria-label="Cột phải" className="flex gap-1 rounded-lg bg-muted p-0.5 text-sm">
            {([["channels", "Kênh"], ["preview", "Xem trước"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={side === k}
                className={cn("flex-1 rounded-md px-2 py-1 font-medium transition-colors", side === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                onClick={() => setSide(k)}
              >
                {label}
              </button>
            ))}
          </div>
          {side === "preview" && (
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
          )}
          <div className={cn("flex items-center justify-between gap-2", side === "preview" && "hidden")}>
            <p className="text-sm font-medium">Đăng lên kênh</p>
            {active.length > 1 && (
              <button
                type="button"
                className="rounded text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20"
                onClick={() => setSelected(chosen.length === active.length ? [] : active.map((a) => a.id))}
              >
                {chosen.length === active.length ? "Bỏ chọn" : "Chọn tất cả"}
              </button>
            )}
          </div>
          {isLoading && side === "channels" && <Loader2 className="size-4 animate-spin" />}
          <div className={cn("divide-y divide-border overflow-hidden rounded-lg ring-1 ring-border", side === "preview" && "hidden")}>
          {accounts.map((a) => {
            const on = selected.includes(a.id)
            const text = openCaption[a.id] ? captions[a.id] ?? "" : content
            return (
              <div key={a.id} className={cn("space-y-2 px-3 py-2.5 transition-colors duration-150", on && "bg-primary/[0.04]")}>
                <label className={cn("flex min-h-8 items-center gap-2.5 text-sm max-sm:min-h-11", a.status === "active" ? "cursor-pointer" : "opacity-60")}>
                  <Checkbox checked={on} disabled={a.status !== "active"} onChange={() => toggle(a)} />
                  <NetworkMark network={a.network} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">{NETWORK_META[a.network]?.label ?? a.network}</span>
                  </span>
                </label>
                {a.status !== "active" && <p className="pl-6 text-xs text-destructive">Cần liên kết lại ở tab Kênh</p>}
                {on && (
                  <>
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => {
                      setOpenCaption((o) => ({ ...o, [a.id]: !o[a.id] }))
                      setCaptions((c) => ({ ...c, [a.id]: c[a.id] ?? content }))
                    }}>
                      {openCaption[a.id] ? "Dùng nội dung chung" : "Sửa nội dung riêng cho kênh này"}
                    </button>
                    {openCaption[a.id] && (
                      <Textarea rows={4} value={captions[a.id] ?? ""} onChange={(e) => setCaptions((c) => ({ ...c, [a.id]: e.target.value }))} aria-label={`Nội dung riêng cho ${a.name}`} />
                    )}
                    <div className="text-right text-xs"><Counter text={withUtm(text, a.network, utmCfg)} limit={CAPTION_LIMITS[a.network]} /></div>
                    {a.network === "facebook" && (
                      <div className="space-y-1">
                        <Textarea rows={2} maxLength={8000} value={fbFirst[a.id] ?? ""} placeholder="Bình luận đầu tiên (tuỳ chọn) — vd link mua hàng, hashtag" aria-label={`Bình luận đầu tiên trên ${a.name}`}
                          onChange={(e) => setFbFirst((x) => ({ ...x, [a.id]: e.target.value }))} />
                        <p className="text-xs text-muted-foreground">Fanpage tự bình luận ngay dưới bài vừa đăng. Cần kết nối Fanpage này ở Cài đặt › Kết nối › Fanpage Facebook.</p>
                      </div>
                    )}
                    {a.network === "youtube" && (
                      <YoutubePostOptions account={a} value={ytChoice[a.id] ?? EMPTY_YOUTUBE_CHOICE} onChange={(c) => setYtChoice((x) => ({ ...x, [a.id]: c }))} />
                    )}
                    {a.network === "tiktok" && (
                      <TiktokPostOptions
                        account={a}
                        value={ttChoice[a.id] ?? EMPTY_TIKTOK_CHOICE}
                        onChange={(c) => setTtChoice((x) => ({ ...x, [a.id]: c }))}
                        durationSec={videoDuration}
                      />
                    )}
                  </>
                )}
              </div>
            )
          })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
