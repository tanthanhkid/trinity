"use client"

import { useRef, useState } from "react"
import { Download, FileUp, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { getApiErrorMessage } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { useSocialAccounts, useSocialImport, type SocialImportMode, type SocialImportPlan, type SocialImportResult, type SocialImportRowPlan } from "@/hooks/use-social"
import { buildCsvTemplate } from "./social-csv-template"

const MODES: ReadonlyArray<{ mode: SocialImportMode; label: string; hint: string }> = [
  { mode: "drafts", label: "Tạo nháp", hint: "Lưu thành bài nháp để xem và sửa rồi đăng sau — chưa đăng gì." },
  { mode: "schedule", label: "Hẹn đăng", hint: "Tạo bài hẹn giờ ra kênh. Mỗi dòng cần kênh và giờ (hoặc “hàng đợi”); không có đăng ngay." },
]

const fmt = (iso: string) => new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso))

/** Cột Giờ: hàng đợi kèm khung đã chọn; không có giờ ⇒ "—". */
export function importWhen(p: SocialImportRowPlan["preview"]): string {
  if (p.use_queue) return p.scheduled_at ? `Hàng đợi · ${fmt(p.scheduled_at)}` : "Hàng đợi"
  return p.scheduled_at ? fmt(p.scheduled_at) : "—"
}

/** Đọc tệp thành chữ (jsdom/trình duyệt cũ chưa có `File.text`). */
function readFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text()
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ""))
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

/** Hộp thoại nhập nhiều bài từ CSV: chọn chế độ → tệp/dán chữ → Kiểm tra → Tạo N bài → kết quả. */
export function SocialImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const accounts = useSocialAccounts(open)
  const { plan: planMut, run } = useSocialImport()
  const [mode, setMode] = useState<SocialImportMode>("drafts")
  const [csv, setCsv] = useState("")
  // Bản kiểm tra đang hiện — gắn với đúng chữ + chế độ đã kiểm; sửa chữ/chế độ sau đó thì bỏ (không cho tạo bản chưa kiểm).
  const [plan, setPlan] = useState<(SocialImportPlan & { csv: string }) | null>(null)
  const [result, setResult] = useState<SocialImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const stale = !plan || plan.csv !== csv || plan.mode !== mode
  const reset = () => {
    setPlan(null)
    setResult(null)
  }
  const close = (v: boolean) => {
    if (!v) {
      setCsv("")
      reset()
    }
    onOpenChange(v)
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    try {
      setCsv(await readFile(file))
      reset()
    } catch {
      toast.error("Không đọc được tệp.")
    }
  }

  const check = () =>
    planMut.mutate(
      { csv, mode },
      {
        onSuccess: (p) => {
          setPlan({ ...p, csv, mode })
          setResult(null)
        },
        onError: (e) => toast.error(getApiErrorMessage(e, "Không kiểm tra được CSV")),
      },
    )

  const create = () => {
    if (!plan || stale) return
    run.mutate(
      { csv: plan.csv, mode: plan.mode, plan_hash: plan.plan_hash },
      {
        onSuccess: (r) => {
          setResult(r)
          setPlan(null)
          toast.success(r.mode === "drafts" ? `Đã tạo ${r.created.length} bài nháp.` : `Đã hẹn ${r.created.length} bài.`)
        },
        onError: (e) => {
          // 409: dữ liệu đổi giữa lúc kiểm và lúc tạo ⇒ bỏ bản kiểm cũ, buộc kiểm lại.
          setPlan(null)
          toast.error(getApiErrorMessage(e, "Không nhập được"))
        },
      },
    )
  }

  const downloadTemplate = () => {
    const names = (accounts.data ?? []).filter((a) => a.status === "active").map((a) => a.name)
    const url = URL.createObjectURL(new Blob([buildCsvTemplate(names)], { type: "text/csv;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = "mau-nhap-bai.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Nhập nhiều bài từ CSV</DialogTitle>
          <DialogDescription>Tối đa 200 dòng. Cột: noi_dung, kenh, gio_dang (giờ Việt Nam), tep, binh_luan_dau, tieu_de_youtube, utm.</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
          <div role="radiogroup" aria-label="Chế độ nhập" className="flex flex-wrap gap-2">
            {MODES.map((m) => (
              <Button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} size="sm" variant={mode === m.mode ? "soft" : "outline"} onClick={() => { setMode(m.mode); setResult(null) }}>
                {m.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{MODES.find((m) => m.mode === mode)!.hint}</p>

          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Chọn tệp CSV" data-testid="csv-file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = "" }} />
            <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <FileUp className="size-4" /> Chọn tệp CSV
            </Button>
            <button type="button" className="inline-flex items-center gap-1 text-sm text-primary hover:underline" onClick={downloadTemplate}>
              <Download className="size-3.5" /> Tải file mẫu
            </button>
          </div>
          <Textarea value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null) }} rows={5} placeholder="Hoặc dán nội dung CSV vào đây (dòng đầu là tiêu đề cột)" aria-label="Nội dung CSV" className="font-mono text-xs" />

          {plan && (
            <div className="flex flex-col gap-2" data-testid="import-plan">
              <p className="text-sm">
                <b>{plan.ok_count}</b> / {plan.total} dòng hợp lệ
                {plan.error_count > 0 && <span className="text-destructive"> · {plan.error_count} dòng lỗi (sẽ bị bỏ qua)</span>}
                {stale && <span className="text-[var(--color-app-tag-amber-ink)]"> · Nội dung đã đổi — bấm “Kiểm tra” lại</span>}
              </p>
              {plan.unknown_columns && plan.unknown_columns.length > 0 && <p className="text-xs text-[var(--color-app-tag-amber-ink)]">Bỏ qua cột lạ: {plan.unknown_columns.join(", ")}</p>}
              <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/8">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Dòng</TableHead>
                      <TableHead>Kênh</TableHead>
                      <TableHead>Giờ</TableHead>
                      <TableHead>Nội dung</TableHead>
                      <TableHead>Kiểm tra</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.rows.map((r) => (
                      <TableRow key={r.row} data-testid="import-row" data-ok={r.ok}>
                        <TableCell className="tabular-nums">{r.row}</TableCell>
                        <TableCell>{r.preview.channels.map((c) => c.name).join(", ") || "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">{importWhen(r.preview)}</TableCell>
                        <TableCell className="max-w-56 truncate" title={r.preview.content_excerpt}>{r.preview.content_excerpt || "(chỉ có tệp)"}</TableCell>
                        <TableCell className="min-w-48 whitespace-normal text-xs">
                          {r.ok && r.warnings.length === 0 && <span className="text-muted-foreground">Hợp lệ</span>}
                          {r.errors.map((e, i) => <p key={`e${i}`} className="text-destructive">{e}</p>)}
                          {r.warnings.map((w, i) => <p key={`w${i}`} className="text-[var(--color-app-tag-amber-ink)]">{w}</p>)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {result && (
            <div className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3 text-sm" data-testid="import-result" role="status">
              <p>
                {result.mode === "drafts" ? "Đã tạo" : "Đã hẹn"} <b>{result.created.length}</b> bài{result.mode === "drafts" ? " nháp" : ""}
                {result.skipped.length > 0 ? `, bỏ qua ${result.skipped.length} dòng.` : "."}
              </p>
              {result.skipped.map((s) => (
                <p key={s.row} className={cn("text-xs text-destructive")}>Dòng {s.row}: {s.errors.join(" ")}</p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>Đóng</Button>
          <Button type="button" variant="outline" disabled={!csv.trim() || planMut.isPending} onClick={check}>
            {planMut.isPending && <Loader2 className="size-4 animate-spin" />} Kiểm tra
          </Button>
          <Button type="button" disabled={stale || !plan || plan.ok_count === 0 || run.isPending} onClick={create}>
            {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Tạo {plan && !stale ? plan.ok_count : 0} bài
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Nút "Nhập CSV" (thanh công cụ tab Lịch) + hộp thoại. */
export function SocialImportButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Upload className="size-4" /> Nhập CSV
      </Button>
      <SocialImportDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
