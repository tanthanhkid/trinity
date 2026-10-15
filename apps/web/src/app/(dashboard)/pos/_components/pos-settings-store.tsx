"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { usePosConfigMutation, usePosSettings } from "@/hooks/pos/use-pos"
import { useProductCategories } from "@/hooks/products/use-product-categories"
import { posErrorMessage } from "@/lib/pos-format"
import type { PosSettings } from "@/types/pos"
import { cn } from "@/lib/utils"

const schema = z.object({
  store_name: z.string().trim().min(1, "Nhập tên quán").max(255),
  address: z.string().trim().max(500),
  phone: z.string().trim().max(32),
  receipt_footer: z.string().trim().max(500),
  bank_bin: z.string().trim().regex(/^(\d{6})?$/, "BIN gồm đúng 6 chữ số"),
  bank_account_no: z.string().trim().regex(/^(\d{4,19})?$/, "Số tài khoản gồm 4–19 chữ số"),
  bank_account_name: z.string().trim().max(255),
})
type Form = z.infer<typeof schema>
const FIELDS: Array<{ name: keyof Form; label: string; placeholder?: string }> = [
  { name: "store_name", label: "Tên quán" }, { name: "address", label: "Địa chỉ" }, { name: "phone", label: "Số điện thoại" },
  { name: "receipt_footer", label: "Lời chào cuối hoá đơn", placeholder: "Cảm ơn quý khách!" },
  { name: "bank_bin", label: "Mã ngân hàng (BIN, 6 số) nhận chuyển khoản", placeholder: "6 chữ số" },
  { name: "bank_account_no", label: "Số tài khoản nhận tiền" }, { name: "bank_account_name", label: "Tên chủ tài khoản" },
]

/** Thông tin quán, tài khoản nhận QR VietQR, và danh mục hiển thị trong menu POS (rỗng = tất cả sản phẩm đang bán có giá). */
export function PosSettingsStore() {
  const { data } = usePosSettings()
  // `key` theo nội dung server: sau khi lưu/tải lại, form khởi tạo lại từ dữ liệu mới (không cần effect + setState).
  return data ? <StoreForm key={JSON.stringify(data)} data={data} /> : null
}

function StoreForm({ data }: { data: PosSettings }) {
  const cats = useProductCategories(false).data ?? []
  const save = usePosConfigMutation(["settings", "menu"])
  const [catIds, setCatIds] = useState<number[]>(data.menu_category_ids)
  const { register, handleSubmit, formState: { errors, isDirty } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      store_name: data.store_name, address: data.address ?? "", phone: data.phone ?? "", receipt_footer: data.receipt_footer ?? "",
      bank_bin: data.bank_bin ?? "", bank_account_no: data.bank_account_no ?? "", bank_account_name: data.bank_account_name ?? "",
    },
  })

  const submit = handleSubmit((f) =>
    // Ô trống → null (BE: `@Matches` trên chuỗi rỗng sẽ 400; null = xoá giá trị).
    save.mutate({ method: "patch", url: "/pos/settings", body: {
      store_name: f.store_name, menu_category_ids: catIds,
      address: f.address || null, phone: f.phone || null, receipt_footer: f.receipt_footer || null,
      bank_bin: f.bank_bin || null, bank_account_no: f.bank_account_no || null, bank_account_name: f.bank_account_name || null,
    } }, {
      onSuccess: () => toast.success("Đã lưu cấu hình quán"),
      onError: (e) => toast.error(posErrorMessage(e, "Không lưu được")),
    }),
  )
  const catsDirty = JSON.stringify([...catIds].sort()) !== JSON.stringify([...data.menu_category_ids].sort())

  const saveButton = (
    <Button type="submit" className="min-h-11 gap-1.5" disabled={save.isPending || (!isDirty && !catsDirty)}><Save aria-hidden /> Lưu cấu hình</Button>
  )

  return (
    <form onSubmit={submit} className="space-y-4 rounded-[var(--radius)] border bg-card p-4">
      <h2 className="text-base font-bold text-foreground">Thông tin quán &amp; thanh toán</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.name} className="space-y-1.5">
            <Label htmlFor={`pos-set-${f.name}`}>{f.label}</Label>
            <Input id={`pos-set-${f.name}`} className="h-11" placeholder={f.placeholder} aria-invalid={!!errors[f.name]} {...register(f.name)} />
            {errors[f.name] && <p role="alert" className="text-sm text-destructive">{errors[f.name]?.message}</p>}
          </div>
        ))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-foreground">Danh mục hiển thị trong menu POS</legend>
        <p className="text-xs text-muted-foreground">Không chọn danh mục nào = hiện mọi sản phẩm đang bán có giá (kể cả sản phẩm ngoài quán). Nên chọn các danh mục cần hiển thị trên menu bán hàng.</p>
        <div className="flex flex-wrap gap-2">
          {cats.map((c) => {
            const on = catIds.includes(c.id)
            return (
              <button key={c.id} type="button" aria-pressed={on} onClick={() => setCatIds((ids) => (on ? ids.filter((x) => x !== c.id) : [...ids, c.id]))}
                className={cn("min-h-11 rounded-full border px-4 text-sm font-semibold", on ? "border-primary/30 bg-primary/10 text-[var(--color-app-primary-ink)]" : "bg-background text-foreground hover:bg-muted")}>
                {c.name}
              </button>
            )
          })}
        </div>
      </fieldset>
      {/* Điện thoại: thanh dính đáy CHỈ hiện khi có thay đổi; desktop giữ nút ở cuối thẻ như cũ. */}
      {isDirty || catsDirty
        ? <MobileActionBar className="mb-0">{saveButton}</MobileActionBar>
        : <div className="flex justify-end max-sm:hidden">{saveButton}</div>}
    </form>
  )
}
