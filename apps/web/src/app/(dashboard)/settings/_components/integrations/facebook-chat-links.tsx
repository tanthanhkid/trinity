"use client"

import { useRef, useState } from "react"
import QRCode from "react-qr-code"
import { Copy, Download, Link2, Loader2, Plus, QrCode, Trash2 } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { OptionSelect } from "./option-select"
import { useChatLinkMutations, useChatLinks, type ChatLink, type FacebookPageView } from "./use-facebook"
import { apiErrorMessage, type SimpleOption } from "./webhook-types"

const PAGE_SOURCE = "page"

/** Tên tệp an toàn từ tên link (bỏ dấu, ký tự lạ). */
export function qrFileName(name: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `qr-${slug || "mo-chat"}.png`
}

/** Vẽ QR (SVG đang hiện) ra PNG 1024px nền trắng, chữ tên link bên dưới, rồi tải về. */
async function downloadQr(svg: SVGSVGElement, name: string) {
  const xml = new XMLSerializer().serializeToString(svg)
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  await img.decode()
  const size = 1024, pad = 64, foot = 120
  const c = document.createElement("canvas")
  c.width = size + pad * 2
  c.height = size + pad * 2 + foot
  const ctx = c.getContext("2d")
  if (!ctx) throw new Error("canvas")
  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, pad, pad, size, size)
  ctx.fillStyle = "#111"
  ctx.font = "600 48px system-ui, -apple-system, sans-serif"
  ctx.textAlign = "center"
  ctx.fillText(name.slice(0, 40), c.width / 2, size + pad + 80)
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"))
  if (!blob) throw new Error("png")
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = qrFileName(name)
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function LinkCard({ l, highlight }: { l: ChatLink; highlight: boolean }) {
  const m = useChatLinkMutations()
  const qrRef = useRef<HTMLDivElement>(null)
  const [del, setDel] = useState(false)
  const url = l.url ?? l.messenger_url
  const copy = () => navigator.clipboard.writeText(url).then(() => toast.success("Đã chép link"), () => toast.error("Không chép được — bôi đen link để chép"))
  const save = () => {
    const svg = qrRef.current?.querySelector("svg")
    if (svg) downloadQr(svg, l.name).catch(() => toast.error("Không tải được ảnh QR"))
  }
  return (
    <Card id={`chat-link-${l.id}`} className={cn(highlight && "ring-2 ring-primary")} data-testid="chat-link-card">
      <CardContent className="flex gap-4 p-4 max-sm:flex-col">
        <div ref={qrRef} className={cn("shrink-0 self-start rounded-md bg-white p-2", !l.is_active && "opacity-40")} data-testid="chat-link-qr">
          <QRCode value={url} size={128} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{l.name}</p>
            {!l.is_active && <Badge variant="secondary">Đang tắt</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            Fanpage {l.page_name ?? l.page_id} · Nguồn khách: {l.source_label ?? "theo Fanpage"}
          </p>
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={url}>{url}</code>
            <Button size="icon" variant="outline" className="size-8 shrink-0" onClick={copy} aria-label={`Chép link ${l.name}`}><Copy className="size-4" /></Button>
          </div>
          <p className="text-sm"><b>{l.clicks}</b> lượt mở · <b>{l.chats}</b> khách vào chat</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={save}><Download className="size-4" /> Tải ảnh QR</Button>
            <div className="ml-auto flex items-center gap-1">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={l.is_active}
                  disabled={m.update.isPending}
                  onCheckedChange={(v) => m.update.mutate({ id: l.id, is_active: v === true }, { onError: (e) => toast.error(apiErrorMessage(e, "Không đổi được")) })}
                  aria-label={`Bật link ${l.name}`}
                />
                Bật
              </label>
              <Button size="icon" variant="ghost" className="size-8" onClick={() => setDel(true)} aria-label={`Xoá link ${l.name}`}><Trash2 className="size-4" /></Button>
            </div>
          </div>
        </div>
      </CardContent>
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Xoá link mở chat?"
        description={<>Link <b>{l.name}</b> và mã QR đã in sẽ không mở được nữa. Khách đã vào qua link vẫn giữ nguyên nguồn. Muốn tạm dừng thì tắt thay vì xoá.</>}
        confirmLabel="Xoá link"
        pending={m.remove.isPending}
        onConfirm={() => m.remove.mutate(l.id, { onSuccess: () => { toast.success("Đã xoá link"); setDel(false) }, onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) })}
      />
    </Card>
  )
}

function CreateDialog({ open, onOpenChange, pages, sources }: { open: boolean; onOpenChange: (o: boolean) => void; pages: FacebookPageView[]; sources: SimpleOption[] }) {
  const m = useChatLinkMutations()
  const [name, setName] = useState("")
  const [pageId, setPageId] = useState("")
  const [source, setSource] = useState(PAGE_SOURCE)
  const page = pageId || pages[0]?.page_id || ""
  const submit = () => {
    if (!name.trim()) return toast.error("Đặt tên cho link")
    m.create.mutate(
      { name: name.trim(), page_id: page, source_id: source === PAGE_SOURCE ? null : Number(source) },
      {
        onSuccess: () => { toast.success("Đã tạo link mở chat"); setName(""); setSource(PAGE_SOURCE); onOpenChange(false) },
        onError: (e) => toast.error(apiErrorMessage(e, "Không tạo được link")),
      },
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tạo link / QR mở chat</DialogTitle>
          <DialogDescription>Khách bấm link hoặc quét QR sẽ mở thẳng Messenger của Fanpage. Khách mới nhắn qua link được ghi nguồn bạn chọn.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="chat-link-name">Tên link</Label>
            <Input id="chat-link-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder='vd "Tờ rơi quán", "QR bàn 5"' />
          </div>
          {pages.length > 1 && (
            <OptionSelect label="Fanpage" value={page} onChange={setPageId} options={pages.map((p) => ({ value: p.page_id, label: p.name }))} className="h-9 w-full max-sm:h-11" />
          )}
          <OptionSelect
            label="Nguồn khách"
            value={source}
            onChange={setSource}
            options={[{ value: PAGE_SOURCE, label: "Theo Fanpage (mặc định)" }, ...sources.map((s) => ({ value: String(s.id), label: s.label }))]}
            className="h-9 w-full max-sm:h-11"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button onClick={submit} disabled={m.create.isPending || !page}>{m.create.isPending && <Loader2 className="size-4 animate-spin" />} Tạo link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Cài đặt › Fanpage › Link mở chat: link/QR mở Messenger kèm nguồn khách, đếm lượt mở và số khách vào chat. */
export function FacebookChatLinks({ pages, sources, highlight }: { pages: FacebookPageView[]; sources: SimpleOption[]; highlight?: number }) {
  const links = useChatLinks(true)
  const [open, setOpen] = useState(false)
  const active = pages.filter((p) => p.is_active)
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        In mã QR lên tờ rơi, quầy, bàn hoặc gắn link lên web, bài đăng: khách bấm là mở Messenger của Fanpage, nhắn tin là thành khách hàng với nguồn của link — biết khách đến từ đâu.
      </p>
      <Button onClick={() => setOpen(true)} disabled={!active.length} className="max-sm:h-11"><Plus className="size-4" /> Tạo link mở chat</Button>
      {!active.length && <p className="text-xs text-muted-foreground">Cần kết nối một Fanpage trước (mục Fanpage).</p>}
      {links.isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Đang tải" />}
      {links.isError && <p className="text-sm text-destructive">Không tải được danh sách link.</p>}
      {links.isSuccess && links.data.length === 0 && <EmptyState icon={QrCode} message="Chưa có link mở chat nào." action={<Button variant="outline" onClick={() => setOpen(true)} disabled={!active.length}><QrCode className="size-4" /> Tạo mã QR</Button>} />}
      <div className="grid gap-3 xl:grid-cols-2">
        {links.data?.map((l) => <LinkCard key={l.id} l={l} highlight={l.id === highlight} />)}
      </div>
      {links.data?.some((l) => !l.url) && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground"><Link2 className="size-3" /> Máy chủ chưa đặt địa chỉ công khai nên link mở thẳng Messenger, không đếm được lượt mở.</p>
      )}
      <CreateDialog open={open} onOpenChange={setOpen} pages={active} sources={sources} />
    </div>
  )
}
