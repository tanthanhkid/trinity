"use client"

/**
 * Form THÊM 1 định nghĩa thuộc tính động cho danh mục đang chọn.
 * Tách khỏi `product-attribute-def-panel.tsx` để file đó gọn hơn.
 */
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  PRODUCT_ATTRIBUTE_TYPES,
  PRODUCT_ATTRIBUTE_TYPE_LABELS,
  attributeTypeNeedsOptions,
  type AttributeOption,
  type CreateAttributeDefPayload,
  type ProductAttributeDef,
  type ProductAttributeType,
} from "@/types/product-category"

/** `mỗi dòng 1 lựa chọn dạng "value:label"` → mảng option, bỏ dòng rỗng/thiếu dấu `:`. */
export function parseOptionsText(text: string): AttributeOption[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.indexOf(":")
      if (idx === -1) return { value: line, label: line }
      return { value: line.slice(0, idx).trim(), label: line.slice(idx + 1).trim() }
    })
    .filter((o) => o.value.length > 0)
}

/** Ngược của `parseOptionsText` — đổ options đã lưu về textarea khi SỬA. */
export function optionsToText(options: AttributeOption[] | null | undefined): string {
  return (options ?? []).map((o) => `${o.value}:${o.label}`).join("\n")
}

/**
 * `initial` có giá trị = chế độ SỬA: `key` bị khoá (là khoá trong
 * `Product.attributes` của mọi sản phẩm — BE cũng không cho đổi) và nút huỷ hiện ra.
 */
export function AttributeDefForm({
  onSubmit,
  isSubmitting,
  initial,
  onCancel,
}: {
  /** Trả Promise → chỉ xoá ô nhập khi lưu THÀNH CÔNG (thất bại thì giữ nguyên để người dùng sửa/thử lại). */
  onSubmit: (payload: CreateAttributeDefPayload) => void | Promise<unknown>
  isSubmitting: boolean
  initial?: ProductAttributeDef | null
  onCancel?: () => void
}) {
  const isEdit = !!initial
  const [key, setKey] = useState(initial?.key ?? "")
  const [label, setLabel] = useState(initial?.label ?? "")
  const [type, setType] = useState<ProductAttributeType>(initial?.type ?? "text")
  const [isRequired, setIsRequired] = useState(initial?.is_required ?? false)
  const [optionsText, setOptionsText] = useState(optionsToText(initial?.options))
  const [error, setError] = useState("")

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      setError("Key chỉ chứa chữ thường/số/gạch dưới, bắt đầu bằng chữ")
      return
    }
    if (label.trim().length < 1) {
      setError("Nhãn không được rỗng")
      return
    }
    const options = attributeTypeNeedsOptions(type) ? parseOptionsText(optionsText) : undefined
    if (attributeTypeNeedsOptions(type) && (!options || options.length === 0)) {
      setError("Kiểu chọn 1/chọn nhiều cần ít nhất 1 lựa chọn")
      return
    }
    setError("")
    const result = onSubmit({ key: key.trim(), label: label.trim(), type, is_required: isRequired, options })
    if (isEdit) return
    Promise.resolve(result).then(
      () => {
        setKey("")
        setLabel("")
        setType("text")
        setIsRequired(false)
        setOptionsText("")
      },
      () => undefined, // lỗi đã được toast ở hook mutation — giữ nguyên nội dung đang nhập
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border border-dashed p-3">
      <p className="text-xs font-semibold text-muted-foreground">
        {isEdit ? `Sửa thuộc tính "${initial?.label}"` : "Thêm thuộc tính"}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="attr-key" className="text-xs">
            Key (kỹ thuật)
          </Label>
          <Input
            id="attr-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="warranty_months"
            disabled={isEdit}
            className="h-8 max-sm:h-11"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="attr-label" className="text-xs">
            Nhãn hiển thị
          </Label>
          <Input
            id="attr-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Bảo hành (tháng)"
            className="h-8 max-sm:h-11"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Kiểu dữ liệu</Label>
          <Select
            value={type}
            onValueChange={(v) => setType((v as ProductAttributeType) ?? "text")}
            items={PRODUCT_ATTRIBUTE_TYPES.map((t) => ({ value: t, label: PRODUCT_ATTRIBUTE_TYPE_LABELS[t] }))}
          >
            <SelectTrigger className="h-8 max-sm:h-11">
              <SelectValue placeholder="Chọn kiểu">
                {(v) => PRODUCT_ATTRIBUTE_TYPE_LABELS[v as ProductAttributeType] ?? v}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRODUCT_ATTRIBUTE_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {PRODUCT_ATTRIBUTE_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Label className="flex items-center gap-2 pt-5 text-sm font-normal max-sm:min-h-11 max-sm:pt-0">
          <Checkbox checked={isRequired} onCheckedChange={setIsRequired} />
          Bắt buộc nhập
        </Label>
      </div>
      {attributeTypeNeedsOptions(type) && (
        <div className="space-y-1">
          <Label className="text-xs">Lựa chọn (mỗi dòng 1 lựa chọn, dạng &quot;value:label&quot;)</Label>
          <Textarea
            rows={3}
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            placeholder={"s:Nhỏ\nm:Vừa\nl:Lớn"}
          />
        </div>
      )}
      <p className="min-h-4 text-xs leading-4 text-destructive">{error}</p>
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
          {isEdit ? "Lưu thay đổi" : "Thêm thuộc tính"}
        </Button>
        {isEdit && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Huỷ
          </Button>
        )}
      </div>
    </form>
  )
}
