"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle, ExternalLink, FlaskConical, Loader2, MessageCircle, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FieldError } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useSocialPosts } from "@/hooks/use-social"
import { OptionSelect } from "./option-select"
import {
  useCommentReply,
  useCommentRuleMutations,
  useCommentRules,
  useFacebookComments,
  type CommentActions,
  type CommentDryRun,
  type CommentRule,
  type CommentRuleInput,
  type CommentStatus,
  type FacebookCommentView,
  type FacebookPageView,
} from "./use-facebook"
import { apiErrorMessage } from "./webhook-types"

const ALL = "all"
const splitWords = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
const splitLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean)
const fmtTime = (iso: string) => new Date(iso).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })

export const COMMENT_STATUS: Record<CommentStatus, { label: string; variant: "success" | "soft" | "secondary" | "destructive" | "outline" }> = {
  done: { label: "Đã xử lý", variant: "success" },
  test: { label: "Chạy thử", variant: "soft" },
  received: { label: "Không luật nào khớp", variant: "outline" },
  skipped: { label: "Bỏ qua (đã trả lời người này)", variant: "secondary" },
  failed: { label: "Facebook từ chối", variant: "destructive" },
  replied: { label: "Nhân viên đã trả lời", variant: "success" },
}

const EMPTY: CommentRuleInput = {
  name: "",
  page_id: null,
  post_id: null,
  keywords: [],
  exclude_keywords: [],
  public_replies: ["Mình đã nhắn riêng cho {ten} rồi nhé, bạn xem tin nhắn giúp mình."],
  private_reply: "Chào {ten}! Cảm ơn bạn đã quan tâm. ",
  hide_if_phone: true,
  once_per_user: true,
  mode: "test",
  is_active: true,
}

/** Tóm tắt việc Trinity đã làm / sẽ làm cho một bình luận. */
function ActionLines({ a, planned }: { a: CommentActions; planned?: boolean }) {
  const verb = planned ? "Sẽ" : "Đã"
  const rows: Array<{ k: string; text: string; error?: string }> = []
  if (a.public_reply) rows.push({ k: "pub", text: `${verb} trả lời công khai: “${a.public_reply.text}”`, error: a.public_reply.error })
  if (a.private_reply) rows.push({ k: "pri", text: `${verb} nhắn riêng qua Messenger: “${a.private_reply.text}”`, error: a.private_reply.error })
  if (a.hide) rows.push({ k: "hide", text: `${verb} ẩn bình luận vì có số điện thoại`, error: a.hide.error })
  if (a.phone_saved) rows.push({ k: "phone", text: "Đã lưu số điện thoại vào khách hàng" })
  a.manual?.forEach((m, i) => rows.push({ k: `man${i}`, text: `Nhân viên ${m.mode === "private" ? "nhắn riêng" : "trả lời công khai"}: “${m.text}”` }))
  if (!rows.length) return null
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      {rows.map((r) => (
        <li key={r.k} className={r.error ? "text-red-600" : undefined}>
          {r.error ? `${r.text.replace(/^(Đã|Sẽ) /, "Chưa ")} — ${r.error}` : r.text}
        </li>
      ))}
    </ul>
  )
}

function RuleDialog({ open, onOpenChange, rule, pages }: { open: boolean; onOpenChange: (o: boolean) => void; rule: CommentRule | null; pages: FacebookPageView[] }) {
  const m = useCommentRuleMutations()
  const init = rule ?? EMPTY
  const [name, setName] = useState(init.name)
  const [pageId, setPageId] = useState(init.page_id ?? ALL)
  const [post, setPost] = useState(init.post_id ? `https://www.facebook.com/${init.post_id}` : "")
  const [keywords, setKeywords] = useState(init.keywords.join(", "))
  const [exclude, setExclude] = useState(init.exclude_keywords.join(", "))
  const [publicReplies, setPublicReplies] = useState(init.public_replies.join("\n"))
  const [privateReply, setPrivateReply] = useState(init.private_reply ?? "")
  const [hide, setHide] = useState(init.hide_if_phone)
  const [once, setOnce] = useState(init.once_per_user)
  const [live, setLive] = useState(init.mode === "live")
  // Lỗi hiện ngay trong hộp thoại (toast có thể bị lớp phủ che ⇒ người dùng tưởng đã lưu).
  const [error, setError] = useState<string | null>(null)
  const pending = m.create.isPending || m.update.isPending
  const social = useSocialPosts()
  // Bài Trinity đã đăng lên Fanpage: link có sẵn id <page>_<post> ⇒ chọn thẳng, khỏi dò link.
  const recent = (social.data?.data ?? [])
    .flatMap((p) => p.targets.filter((t) => t.network === "facebook" && t.status === "published" && t.url && /\d+_\d+/.test(t.url)).map((t) => ({ url: t.url as string, label: p.content.replace(/\s+/g, " ").slice(0, 60) })))
    .slice(0, 10)
  const pickPost = (url: string) => {
    setPost(url)
    const page = url.match(/(\d+)_\d+/)?.[1]
    if (page && pages.some((p) => p.page_id === page)) setPageId(page)
  }

  function failEarly(msg: string) { setError(msg); toast.error(msg) }

  function save() {
    setError(null)
    const postRaw = post.trim()
    // Dán link bài mà để "Mọi Fanpage": tự chọn Page khi đoán được (link có sẵn <page>_<post>, hoặc chỉ có một Page).
    let effectivePage = pageId === ALL ? null : pageId
    // Link có sẵn id Page (<page>_<post>): Page đó phải đã nối và trùng Page đã chọn, không thì luật lưu được mà không bao giờ chạy.
    const fromLink = postRaw.match(/(\d{5,})_\d{5,}/)?.[1] ?? null
    if (fromLink && !pages.some((p) => p.page_id === fromLink)) return failEarly("Bài này thuộc một Fanpage chưa nối với Trinity. Nối Fanpage đó trước, hoặc dán link bài của Fanpage đã nối.")
    if (fromLink && effectivePage && fromLink !== effectivePage) return failEarly("Bài này thuộc Fanpage khác với Fanpage đã chọn. Chọn lại ô \"Áp cho Fanpage\" hoặc dán đúng link bài.")
    if (postRaw && !effectivePage) {
      const guess = fromLink ?? (pages.length === 1 ? pages[0].page_id : null)
      if (guess) { effectivePage = guess; setPageId(guess) }
    }
    const body: CommentRuleInput = {
      name: name.trim(),
      page_id: effectivePage,
      post_id: post.trim() || null,
      keywords: splitWords(keywords),
      exclude_keywords: splitWords(exclude),
      public_replies: splitLines(publicReplies),
      private_reply: privateReply.trim() || null,
      hide_if_phone: hide,
      once_per_user: once,
      mode: live ? "live" : "test",
      is_active: rule?.is_active ?? true,
    }
    const fail = (msg: string) => { setError(msg); toast.error(msg) }
    if (!body.name) return fail("Đặt tên cho luật")
    if (body.post_id && !body.page_id) return fail("Bài này thuộc Fanpage nào? Chọn ở ô \"Áp cho Fanpage\" rồi bấm Lưu luật lại.")
    if (!body.public_replies.length && !body.private_reply && !body.hide_if_phone) return fail("Luật cần ít nhất một việc: trả lời công khai, nhắn riêng hoặc ẩn bình luận có số điện thoại.")
    const done = { onSuccess: () => { toast.success("Đã lưu luật"); onOpenChange(false) }, onError: (e: unknown) => fail(apiErrorMessage(e, "Không lưu được luật")) }
    if (rule) m.update.mutate({ id: rule.id, ...body }, done)
    else m.create.mutate(body, done)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Sửa luật bình luận" : "Thêm luật bình luận"}</DialogTitle>
          <DialogDescription>Khách bình luận có từ khoá ⇒ Trinity trả lời dưới bình luận và nhắn riêng cho khách qua Messenger.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cr-name">Tên luật</Label>
            <Input id="cr-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Gửi bảng giá khi khách hỏi giá" className="max-sm:h-11" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <OptionSelect label="Áp cho Fanpage" value={pageId} onChange={setPageId} options={[{ value: ALL, label: "Mọi Fanpage" }, ...pages.map((p) => ({ value: p.page_id, label: p.name }))]} className="h-9 w-full max-sm:h-11" />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cr-post" className="text-xs font-normal text-muted-foreground">Chỉ bài này (bỏ trống = mọi bài)</Label>
              <Input id="cr-post" value={post} onChange={(e) => setPost(e.target.value)} placeholder="Dán link bài" className="h-9 max-sm:h-11" />
            </div>
          </div>
          {recent.length > 0 && (
            <OptionSelect label="Hoặc chọn bài Trinity đã đăng" value={recent.some((x) => x.url === post) ? post : ""} onChange={pickPost} options={recent.map((x) => ({ value: x.url, label: x.label }))} placeholder="Chọn bài" className="h-9 w-full max-sm:h-11" />
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cr-kw">Từ khoá (cách nhau dấu phẩy)</Label>
            <Input id="cr-kw" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="giá, inbox, tư vấn" className="max-sm:h-11" />
            <p className="text-xs text-muted-foreground">Không phân biệt hoa thường, có dấu hay không. Bỏ trống = mọi bình luận.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cr-ex">Bỏ qua bình luận có từ</Label>
            <Input id="cr-ex" value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="lừa đảo, spam" className="max-sm:h-11" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cr-pub">Trả lời công khai dưới bình luận (mỗi dòng một câu, Trinity chọn ngẫu nhiên)</Label>
            <Textarea id="cr-pub" rows={3} value={publicReplies} onChange={(e) => setPublicReplies(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cr-pri">Nhắn riêng qua Messenger</Label>
            <Textarea id="cr-pri" rows={4} value={privateReply} onChange={(e) => setPrivateReply(e.target.value)} />
            <p className="text-xs text-muted-foreground">Viết <code>{"{ten}"}</code> để chèn tên khách. Facebook chỉ cho nhắn riêng một tin cho mỗi bình luận, trong 7 ngày; khách trả lời thì tin về Hộp thư.</p>
          </div>
          <div className="space-y-3 rounded-lg border p-3">
            <label className="flex items-center justify-between gap-3 text-sm">Ẩn bình luận có số điện thoại (số vẫn được lưu vào khách hàng)<Switch checked={hide} onCheckedChange={setHide} aria-label="Ẩn bình luận có số điện thoại" /></label>
            <label className="flex items-center justify-between gap-3 text-sm">Mỗi người chỉ được trả lời một lần mỗi bài<Switch checked={once} onCheckedChange={setOnce} aria-label="Mỗi người một lần mỗi bài" /></label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Chạy thật<span className="block text-xs text-muted-foreground">Tắt = chạy thử: chỉ ghi lại việc sẽ làm, không gửi gì lên Facebook.</span></span>
              <Switch checked={live} onCheckedChange={setLive} aria-label="Chạy thật" />
            </label>
          </div>
        </div>
        {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-200" data-testid="rule-form-error">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Huỷ</Button>
          <Button onClick={save} disabled={pending}>{pending && <Loader2 className="mr-1 size-4 animate-spin" />}Lưu luật</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RuleCard({ r, pages, onEdit }: { r: CommentRule; pages: FacebookPageView[]; onEdit: () => void }) {
  const m = useCommentRuleMutations()
  const [confirm, setConfirm] = useState(false)
  const pageName = r.page_id ? (pages.find((p) => p.page_id === r.page_id)?.name ?? "Fanpage đã ngắt") : "Mọi Fanpage"
  return (
    <Card>
      <CardContent className="space-y-2 py-4" data-testid="comment-rule">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            <p className="text-xs text-muted-foreground">{pageName} · {r.post_id ? <a href={`https://www.facebook.com/${r.post_id}`} target="_blank" rel="noreferrer" className="underline">một bài</a> : "mọi bài"}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={r.mode === "live" ? "success" : "soft"}>{r.mode === "live" ? "Chạy thật" : "Chạy thử"}</Badge>
            <Switch checked={r.is_active} onCheckedChange={(v) => m.update.mutate({ id: r.id, is_active: v }, { onError: (e) => toast.error(apiErrorMessage(e, "Không lưu được")) })} aria-label={`Bật/tắt luật ${r.name}`} />
          </div>
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">Khi bình luận có: </span>
          {r.keywords.length ? r.keywords.map((k) => <Badge key={k} variant="outline" className="mr-1">{k}</Badge>) : <i>mọi bình luận</i>}
        </p>
        {r.private_reply && <p className="line-clamp-2 text-xs text-muted-foreground">Nhắn riêng: {r.private_reply}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onEdit} className="max-sm:h-11"><Pencil className="mr-1 size-3.5" />Sửa</Button>
          <Button variant="outline" size="sm" onClick={() => setConfirm(true)} className="text-red-600 max-sm:h-11"><Trash2 className="mr-1 size-3.5" />Xoá</Button>
        </div>
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} pending={m.remove.isPending} title={`Xoá luật "${r.name}"?`} description="Bình luận đã xử lý vẫn được giữ lại." onConfirm={() => m.remove.mutate(r.id, { onSuccess: () => { setConfirm(false); toast.success("Đã xoá luật") }, onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) })} />
      </CardContent>
    </Card>
  )
}

function TryRule({ pages }: { pages: FacebookPageView[] }) {
  const m = useCommentRuleMutations()
  const [text, setText] = useState("")
  const [res, setRes] = useState<CommentDryRun | null>(null)
  const run = () =>
    m.dryRun.mutate({ message: text, page_id: pages[0]?.page_id ?? null, from_name: "Lan" }, { onSuccess: setRes, onError: (e) => toast.error(apiErrorMessage(e, "Không thử được")) })
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <p className="flex items-center gap-1.5 font-medium"><FlaskConical className="size-4" />Thử luật</p>
        <p className="text-xs text-muted-foreground">Gõ một bình luận mẫu để xem Trinity sẽ làm gì. Không gửi gì lên Facebook.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Cho mình xin giá với ạ" className="max-sm:h-11" aria-label="Bình luận mẫu" />
          <Button variant="outline" onClick={run} disabled={!text.trim() || m.dryRun.isPending} className="max-sm:h-11">{m.dryRun.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}Thử</Button>
        </div>
        {res && (
          <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm" data-testid="dry-run-result">
            {res.matched_rule ? <p>Khớp luật <b>{res.matched_rule.name}</b>{res.matched_rule.mode === "test" && " (đang chạy thử)"}</p> : <p>Không luật nào khớp: Trinity chỉ lưu bình luận và tạo khách hàng.</p>}
            {res.phone_found && <p className="text-xs text-muted-foreground">Thấy số điện thoại: {res.phone_found}</p>}
            <ActionLines a={res.actions} planned />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Ô trả lời tay: công khai dưới bình luận, hoặc nhắn riêng qua Messenger (Facebook cho 1 lần, trong 7 ngày). */
function ReplyBox({ c }: { c: FacebookCommentView }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [mode, setMode] = useState<"public" | "private">("public")
  const reply = useCommentReply()
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} className="max-sm:h-11" data-testid="comment-reply-open">
        <MessageCircle className="mr-1 size-3.5" />Trả lời
      </Button>
    )
  }
  const send = () =>
    reply.mutate(
      { id: c.id, text: text.trim(), mode },
      {
        onSuccess: () => {
          toast.success(mode === "private" ? "Đã nhắn riêng cho khách qua Messenger." : "Đã trả lời dưới bình luận.")
          setText("")
          setOpen(false)
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Không gửi được trả lời.")),
      },
    )
  return (
    <div className="space-y-2 rounded-lg border p-2" data-testid="comment-reply-box">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Cách trả lời">
        <Button type="button" size="sm" variant={mode === "public" ? "secondary" : "ghost"} aria-pressed={mode === "public"} onClick={() => setMode("public")} className="max-sm:h-11">Trả lời công khai</Button>
        <Button type="button" size="sm" variant={mode === "private" ? "secondary" : "ghost"} aria-pressed={mode === "private"} disabled={c.can_private_reply === false} onClick={() => setMode("private")} className="max-sm:h-11" title={c.can_private_reply === false ? "Đã nhắn riêng hoặc bình luận quá 7 ngày" : undefined}>Nhắn riêng (Messenger)</Button>
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder={mode === "private" ? "Tin nhắn riêng gửi tới khách…" : "Trả lời hiện công khai dưới bình luận…"} aria-label="Nội dung trả lời" />
      {mode === "private" && <p className="text-xs text-muted-foreground">Facebook chỉ cho nhắn riêng một lần cho mỗi bình luận, trong 7 ngày. Sau đó trò chuyện tiếp ở Hộp thư.</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} className="max-sm:h-11">Huỷ</Button>
        <Button type="button" size="sm" disabled={!text.trim() || reply.isPending} onClick={send} className="max-sm:h-11" data-testid="comment-reply-send">
          {reply.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}Gửi
        </Button>
      </div>
    </div>
  )
}

function CommentRow({ c }: { c: FacebookCommentView }) {
  const st = COMMENT_STATUS[c.status] ?? COMMENT_STATUS.received
  return (
    <li className="space-y-1 border-b py-3 last:border-0" data-testid="comment-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm"><b>{c.from_name ?? "Người dùng Facebook"}</b> <span className="text-xs text-muted-foreground">· {c.page_name} · {fmtTime(c.commented_at)}</span></p>
        <Badge variant={st.variant}>{st.label}</Badge>
      </div>
      <p className="whitespace-pre-wrap text-sm">{c.message || <i className="text-muted-foreground">(không có chữ)</i>}</p>
      <ActionLines a={c.actions} planned={c.status === "test"} />
      {c.note && c.status !== "test" && <p className="text-xs text-muted-foreground">{c.note}</p>}
      <div className="flex flex-wrap gap-3 text-xs">
        <a href={c.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">Xem bài <ExternalLink className="size-3" /></a>
        {c.contact_id && <Link href={`/contacts/${c.contact_id}`} className="text-primary underline-offset-2 hover:underline">Mở khách hàng</Link>}
        {c.answered === false && <span className="font-medium text-amber-700 dark:text-amber-300">Chưa ai trả lời</span>}
      </div>
      <ReplyBox c={c} />
    </li>
  )
}

/** Cài đặt > Fanpage > Bình luận tự động (kiểu ManyChat): luật từ khoá ⇒ trả lời công khai + nhắn riêng, ẩn bình luận có SĐT. */
export function FacebookComments({ pages, enabled }: { pages: FacebookPageView[]; enabled: boolean }) {
  const rules = useCommentRules(true)
  const [onlyUnanswered, setOnlyUnanswered] = useState(false)
  const comments = useFacebookComments(true, onlyUnanswered)
  const [editing, setEditing] = useState<CommentRule | "new" | null>(null)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Khách bình luận dưới bài của Fanpage ⇒ Trinity lưu lại, tạo khách hàng (bình luận có số điện thoại thì lưu số), và theo luật: trả lời dưới bình luận, nhắn riêng cho khách qua Messenger. Luật mới ở chế độ chạy thử, xem kết quả ổn rồi mới bật chạy thật.</p>
      {!enabled && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />Ứng dụng Facebook của công ty chưa được cấp quyền đọc và trả lời bình luận. Bạn vẫn soạn luật trước được; khi bật xong, kết nối lại Fanpage là Trinity bắt đầu nhận bình luận.
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Luật tự xử lý</h3>
        <Button size="sm" onClick={() => setEditing("new")} className="max-sm:h-11"><Plus className="mr-1 size-4" />Thêm luật</Button>
      </div>
      {rules.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
      {rules.isError && <FieldError>Không tải được luật.</FieldError>}
      {rules.isSuccess && rules.data.length === 0 && <EmptyState icon={MessageCircle} action={<Button variant="outline" onClick={() => setEditing("new")}><Plus className="size-4" /> Tạo luật trả lời</Button>} message='Chưa có luật nào. Bấm "Thêm luật", ví dụ: khách bình luận "giá" thì nhắn riêng bảng giá.' />}
      <div className="grid gap-3 lg:grid-cols-2">
        {rules.data?.map((r) => <RuleCard key={r.id} r={r} pages={pages} onEdit={() => setEditing(r)} />)}
      </div>
      <TryRule pages={pages} />
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Bình luận gần đây</h3>
            <div className="flex gap-1" role="group" aria-label="Lọc bình luận">
              <Button type="button" size="sm" variant={onlyUnanswered ? "ghost" : "secondary"} aria-pressed={!onlyUnanswered} onClick={() => setOnlyUnanswered(false)} className="max-sm:h-11">Tất cả</Button>
              <Button type="button" size="sm" variant={onlyUnanswered ? "secondary" : "ghost"} aria-pressed={onlyUnanswered} onClick={() => setOnlyUnanswered(true)} className="max-sm:h-11" data-testid="comments-unanswered">Chưa trả lời</Button>
            </div>
          </div>
          {comments.isSuccess && comments.data.length === 0 && <p className="pt-2 text-sm text-muted-foreground">{onlyUnanswered ? "Không còn bình luận nào chờ trả lời." : "Chưa có bình luận nào về Trinity."}</p>}
          {comments.isError && <p className="pt-2 text-sm text-red-600">Không tải được bình luận.</p>}
          <ul>{comments.data?.map((c) => <CommentRow key={c.id} c={c} />)}</ul>
        </CardContent>
      </Card>
      {editing && <RuleDialog key={editing === "new" ? "new" : editing.id} open onOpenChange={(o) => !o && setEditing(null)} rule={editing === "new" ? null : editing} pages={pages} />}
    </div>
  )
}
