"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useCreateCustomObject, useUpdateCustomObject } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { CUSTOM_ICON_NAMES, customIcon } from "@/lib/custom-objects/icons"
import { cn } from "@/lib/utils"
import type { CustomObjectDef } from "@/types/custom-objects"
import { RoleMultiSelect } from "../roles/role-multi-select"
import { useRoleList } from "../roles/use-roles-api"

/** Bỏ dấu tiếng Việt → slug a-z0-9_ (khoá URL của tính năng). */
export function slugifyObjectKey(label: string): string {
  const base = label.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return (/^[a-z]/.test(base) ? base : `x_${base}`).slice(0, 48)
}

/**
 * Thêm / sửa thông tin 1 tính năng tuỳ biến. Mã (`key`) tự sinh từ tên và KHÔNG đổi được sau khi tạo (là địa chỉ
 * `/x/<mã>`). “Vai trò được thấy” chỉ THU HẸP người xem — không cấp thêm quyền; để trống = mọi người có quyền xem.
 */
export function ObjectFormDialog({ open, onOpenChange, object, onCreated }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  object?: CustomObjectDef
  onCreated?: (key: string) => void
}) {
  const editing = !!object
  const create = useCreateCustomObject()
  const update = useUpdateCustomObject(object?.key ?? "")
  const roles = useRoleList(open)
  const [label, setLabel] = useState(object?.label ?? "")
  const [plural, setPlural] = useState(object?.label_plural ?? "")
  const [pluralTouched, setPluralTouched] = useState(editing)
  const [key, setKey] = useState(object?.key ?? "")
  const [keyTouched, setKeyTouched] = useState(editing)
  const [icon, setIcon] = useState<string | null>(object?.icon ?? "shapes")
  const [description, setDescription] = useState(object?.description ?? "")
  const [showInNav, setShowInNav] = useState(object?.show_in_nav ?? true)
  const [active, setActive] = useState(object?.is_active ?? true)
  const [roleIds, setRoleIds] = useState<number[]>(object?.visible_role_ids ?? [])
  const [prefix, setPrefix] = useState(object?.code_prefix ?? "")
  const pending = create.isPending || update.isPending

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim() || !plural.trim() || (!editing && !key)) { toast.error("Vui lòng nhập tên tính năng"); return }
    const p = prefix.trim().toUpperCase()
    if (p && !/^[A-Z]{2,4}$/.test(p)) { toast.error("Tiền tố mã gồm 2–4 chữ cái không dấu, vd HS"); return }
    const codePrefix = p && p !== (object?.code_prefix ?? "") ? { code_prefix: p } : {}
    const body = { label: label.trim(), label_plural: plural.trim(), icon, description: description.trim() || null, show_in_nav: showInNav, is_active: active, visible_role_ids: roleIds, ...codePrefix }
    const done = (k: string) => { toast.success(editing ? "Đã lưu thay đổi" : "Đã thêm tính năng"); onOpenChange(false); onCreated?.(k) }
    const fail = (err: unknown) => toast.error(getApiErrorMessage(err, "Không lưu được, vui lòng thử lại"))
    if (editing) update.mutate(body, { onSuccess: (o) => done(o.key), onError: fail })
    else create.mutate({ ...body, key }, { onSuccess: (o) => done(o.key), onError: fail })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Sửa “${object?.label}”` : "Thêm tính năng"}</DialogTitle>
          <DialogDescription>Tính năng mới hiện trên menu cho những người được phép xem. Thêm trường (cột dữ liệu) ở bước sau.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="co-label">Tên (số ít) *</Label>
              <Input id="co-label" value={label} maxLength={100} placeholder="Dự án" autoFocus
                onChange={(e) => { setLabel(e.target.value); if (!pluralTouched) setPlural(e.target.value); if (!keyTouched) setKey(slugifyObjectKey(e.target.value)) }} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="co-plural">Tên (số nhiều) *</Label>
              <Input id="co-plural" value={plural} maxLength={100} placeholder="Dự án" onChange={(e) => { setPlural(e.target.value); setPluralTouched(true) }} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-key">Mã (địa chỉ /x/…)</Label>
            <Input id="co-key" value={key} maxLength={48} disabled={editing} placeholder="hoc_sinh" onChange={(e) => { setKey(e.target.value.toLowerCase()); setKeyTouched(true) }} />
            <p className="text-xs text-muted-foreground">{editing ? "Mã không đổi được sau khi tạo." : "Chỉ gồm a-z, 0-9 và dấu gạch dưới; không đổi được sau khi tạo."}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-prefix">Tiền tố mã bản ghi</Label>
            <Input id="co-prefix" value={prefix} maxLength={4} placeholder={editing ? "" : "Tự sinh từ tên, vd HS"} className="w-40 uppercase"
              onChange={(e) => setPrefix(e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase())} />
            <p className="text-xs text-muted-foreground">
              Mỗi bản ghi có mã tăng dần {prefix ? `${prefix}001, ${prefix}002…` : "(vd HS001)"} để gắn thẻ @ ở màn khác. Đổi tiền tố thì mã cũ vẫn tra được; số không bao giờ dùng lại.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Biểu tượng</Label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Chọn biểu tượng">
              {CUSTOM_ICON_NAMES.map((n) => {
                const I = customIcon(n)
                return (
                  <Button key={n} type="button" size="icon" variant={icon === n ? "soft" : "outline"} aria-pressed={icon === n} aria-label={n} className={cn("size-9")} onClick={() => setIcon(n)}>
                    <I className="size-4" />
                  </Button>
                )
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="co-desc">Mô tả</Label>
            <Textarea id="co-desc" rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3 max-sm:min-h-14">
            <span><span className="block font-medium">Hiện trên menu</span><span className="block text-xs text-muted-foreground">Nhóm “Tuỳ biến” ở thanh bên</span></span>
            <Switch checked={showInNav} onCheckedChange={setShowInNav} aria-label="Hiện trên menu" />
          </label>
          {editing && (
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3 max-sm:min-h-14">
              <span><span className="block font-medium">Đang bật</span><span className="block text-xs text-muted-foreground">Tắt = ẩn với mọi người (trừ người cấu hình)</span></span>
              <Switch checked={active} onCheckedChange={setActive} aria-label="Đang bật" />
            </label>
          )}
          <div className="space-y-1.5">
            <Label>Vai trò được thấy</Label>
            <p className="text-xs text-muted-foreground">Để trống = mọi người có quyền xem dữ liệu tuỳ biến. Chọn vai trò = chỉ những vai trò này thấy (không cấp thêm quyền).</p>
            {roles.isError
              ? <p className="text-sm text-amber-700">Bạn không có quyền xem danh sách vai trò nên chưa đặt được mục này.</p>
              : <RoleMultiSelect roles={roles.data ?? []} value={roleIds} onChange={setRoleIds} canGrantSystem loading={roles.isLoading} />}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Huỷ</Button>
            <Button type="submit" disabled={pending}>{pending && <Loader2 className="mr-1.5 size-4 animate-spin" />}{editing ? "Lưu thay đổi" : "Thêm tính năng"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
