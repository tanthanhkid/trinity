"use client"

import { useState } from "react"
import { Hash, Loader2, Pencil, Star, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getApiErrorMessage } from "@/lib/api-client"
import { useSnippetMutations, useSocialSnippets, type SocialSnippet } from "@/hooks/use-social"

/** Chèn mẫu vào cuối nội dung: xuống dòng + mẫu; đã có đúng mẫu ở cuối thì giữ nguyên. */
export function insertSnippet(content: string, snippet: string): string {
  const text = snippet.trim()
  if (!text) return content
  if (content.trimEnd().endsWith(text)) return content
  if (!content.trim()) return text
  return `${content.replace(/\s+$/, "")}\n${text}`
}

/** Bài mới bắt đầu trống: điền sẵn chữ ký mặc định ở cuối ("\n\n" + chữ ký), người dùng gõ phía trên. */
export function signaturePrefill(snippets: SocialSnippet[] | undefined): string {
  const sig = snippets?.find((s) => s.kind === "signature" && s.is_default)
  return sig ? `\n\n${sig.content}` : ""
}

/** Nút "Chèn" trong ô soạn: bộ hashtag và chữ ký; "Quản lý mẫu" mở hộp thoại sửa. */
export function SnippetMenu({ onInsert, onManage }: { onInsert: (content: string) => void; onManage: () => void }) {
  const { data = [] } = useSocialSnippets()
  const tags = data.filter((s) => s.kind === "hashtags")
  const sigs = data.filter((s) => s.kind === "signature")
  const item = (s: SocialSnippet) => (
    <DropdownMenuItem key={s.id} onClick={() => onInsert(s.content)}>
      <span className="truncate">{s.name}</span>
      {s.is_default && <Star className="ml-auto size-3 shrink-0 text-muted-foreground" aria-label="Mặc định" />}
    </DropdownMenuItem>
  )
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="outline" />}>
          <Hash className="size-4" /> Chèn
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
          {data.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">Chưa có mẫu nào.</p>}
          {tags.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Bộ hashtag</DropdownMenuLabel>
              {tags.map(item)}
            </DropdownMenuGroup>
          )}
          {tags.length > 0 && sigs.length > 0 && <DropdownMenuSeparator />}
          {sigs.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Chữ ký</DropdownMenuLabel>
              {sigs.map(item)}
            </DropdownMenuGroup>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" className="text-[13px] text-primary hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center" onClick={onManage}>Quản lý mẫu</button>
    </div>
  )
}

interface Form {
  id?: number
  kind: SocialSnippet["kind"]
  name: string
  content: string
  is_default: boolean
}
const BLANK: Form = { kind: "hashtags", name: "", content: "", is_default: false }

/** Hộp thoại thêm / sửa / xoá bộ hashtag và chữ ký, đặt chữ ký mặc định. */
export function SocialSnippetsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useSocialSnippets()
  const { save, remove } = useSnippetMutations()
  const [form, setForm] = useState<Form | null>(null)
  const [del, setDel] = useState<SocialSnippet | null>(null)
  const list = q.data ?? []
  const close = (v: boolean) => {
    if (!v) setForm(null)
    onOpenChange(v)
  }
  const valid = form !== null && form.name.trim().length > 0 && form.content.trim().length > 0

  const submit = () => {
    if (!form || !valid) return
    const body = form.id
      ? { name: form.name.trim(), content: form.content, is_default: form.kind === "signature" ? form.is_default : undefined }
      : { kind: form.kind, name: form.name.trim(), content: form.content, ...(form.kind === "signature" && form.is_default ? { is_default: true } : {}) }
    save.mutate(
      { id: form.id, body },
      {
        onSuccess: () => {
          toast.success("Đã lưu mẫu.")
          setForm(null)
        },
        onError: (e) => toast.error(getApiErrorMessage(e, "Không lưu được mẫu")),
      },
    )
  }

  const toggleDefault = (s: SocialSnippet) =>
    save.mutate({ id: s.id, body: { is_default: !s.is_default } }, { onError: (e) => toast.error(getApiErrorMessage(e, "Không đổi được chữ ký mặc định")) })

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Bộ hashtag và chữ ký</DialogTitle>
            <DialogDescription>Mẫu chữ dùng lại khi soạn bài. Chữ ký mặc định tự điền vào cuối bài mới.</DialogDescription>
          </DialogHeader>
          {q.isLoading ? (
            <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />
          ) : form ? (
            <div className="space-y-3">
              {!form.id && (
                <div role="radiogroup" aria-label="Loại mẫu" className="flex gap-4 text-sm">
                  {([["hashtags", "Bộ hashtag"], ["signature", "Chữ ký"]] as const).map(([k, label]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-1.5">
                      <input type="radio" name="snippet-kind" checked={form.kind === k} onChange={() => setForm({ ...form, kind: k, is_default: false })} className="size-4 accent-primary" />
                      {label}
                    </label>
                  ))}
                </div>
              )}
              <Input value={form.name} maxLength={80} placeholder="Tên mẫu, vd Khai giảng" aria-label="Tên mẫu" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Textarea
                value={form.content}
                maxLength={2000}
                rows={5}
                aria-label="Nội dung mẫu"
                placeholder={form.kind === "hashtags" ? "#khaigiang #laptrinh (cách nhau bằng dấu cách; tự thêm # và bỏ trùng)" : "Nội dung chữ ký cuối bài"}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
              {form.kind === "signature" && (
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="size-4 accent-primary" />
                  Chữ ký mặc định (tự điền vào bài mới)
                </label>
              )}
            </div>
          ) : list.length === 0 ? (
            <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground" data-testid="snippets-empty">
              Chưa có mẫu nào. Thêm bộ hashtag (vd #khaigiang #hoclaptrinh) hoặc chữ ký cuối bài để chèn nhanh khi soạn bài.
            </p>
          ) : (
            <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto pr-1" data-testid="snippets-list">
              {list.map((s) => (
                <li key={s.id} className="flex items-start gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">{s.kind === "hashtags" ? "Hashtag" : "Chữ ký"}</span>
                      {s.is_default && <span className="shrink-0 text-[11px] font-normal text-primary">Mặc định</span>}
                    </p>
                    <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{s.content}</p>
                  </div>
                  {s.kind === "signature" && (
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={s.is_default ? `Bỏ mặc định ${s.name}` : `Đặt ${s.name} làm mặc định`} onClick={() => toggleDefault(s)}>
                      <Star className={s.is_default ? "size-4 fill-current" : "size-4"} />
                    </Button>
                  )}
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Sửa ${s.name}`} onClick={() => setForm({ id: s.id, kind: s.kind, name: s.name, content: s.content, is_default: s.is_default })}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Xoá ${s.name}`} onClick={() => setDel(s)}>
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            {form ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setForm(null)}>Huỷ</Button>
                <Button type="button" disabled={!valid || save.isPending} onClick={submit}>
                  {save.isPending && <Loader2 className="size-4 animate-spin" />} Lưu mẫu
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setForm({ ...BLANK })}>Thêm mẫu</Button>
                <Button type="button" onClick={() => close(false)}>Xong</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={del !== null}
        onOpenChange={(v) => !v && setDel(null)}
        title="Xoá mẫu?"
        description={del ? `Mẫu "${del.name}" sẽ bị xoá. Bài đã đăng không bị ảnh hưởng.` : ""}
        confirmLabel="Xoá"
        pending={remove.isPending}
        onConfirm={() => { if (del) remove.mutate(del.id, { onSuccess: () => setDel(null), onError: (e) => toast.error(getApiErrorMessage(e, "Không xoá được mẫu")) }) }}
      />
    </>
  )
}
