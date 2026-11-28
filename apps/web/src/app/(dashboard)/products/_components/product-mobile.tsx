"use client"

/**
 * Sản phẩm trên điện thoại (<1024px) — «Ánh xanh», thiết kế sanpham-mobile + sanpham-mobile2:
 *  - Xem + sửa nhanh: ảnh 260 (Chụp ảnh mới), khối nhấn Giá bán + «Đổi giá» (khay đáy) + công tắc Đang bán, bảng thuộc tính,
 *    mô tả, thanh đáy «Sửa toàn bộ thông tin». Đổi giá / ẩn–mở bán LƯU NGAY, toast Hoàn tác.
 *  - Sửa toàn bộ: màn riêng Huỷ · Sửa sản phẩm · Lưu, chip danh mục, thuộc tính động, toast Hoàn tác.
 * Thiết kế bỏ thương hiệu / màu / thẻ / nổi bật khỏi màn sửa — giữ chúng ở cuối màn sửa để không mất chức năng.
 */
import { useId, useState } from "react"
import { Camera, ChevronLeft } from "lucide-react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { Button } from "@/components/ui/button"
import { AxField } from "@/components/ui/field"
import { AX_INPUT_CLASS } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { HeroCard, HeroCardLabel, HeroCardValue } from "@/components/ui/hero-card"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { BottomSheet, BottomSheetClose, BottomSheetContent } from "@/components/ui/bottom-sheet"
import { useAttributeDefs, useProductCategories } from "@/hooks/products/use-product-categories"
import { cn } from "@/lib/utils"
import type { Product } from "@/types/product"
import { DESCRIPTION_MAX, digitsOnly, groupDigits, usableCategories, validateDraft } from "./product-draft"
import { commaToArray, toPickerHex } from "./product-form-schema"
import { DynamicAttributeFields, findMissingRequiredAttributes } from "./dynamic-attribute-fields"
import { formatAttributeValue } from "./product-detail-modal"
import { ProductCover } from "./product-cover"
import { useImagePick } from "./use-image-pick"
import type { ProductEditor } from "./use-product-editor"

const money = (digits: string) => (digits ? `${groupDigits(digits)} ₫` : "Chưa có giá")

export function ProductMobile({ product, canManage, ed }: { product: Product; canManage: boolean; ed: ProductEditor }) {
  const { data: categories = [] } = useProductCategories(true)
  const { data: attributeDefs = [] } = useAttributeDefs(product.category_id)
  const [editing, setEditing] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [priceDraft, setPriceDraft] = useState("")
  const [priceError, setPriceError] = useState("")
  const saved = ed.saved
  const categoryName = categories.find((c) => String(c.id) === saved.category_id)?.name ?? "Chưa phân loại"

  const photo = useImagePick(
    (url) => ed.quickSave({ image_url: url }, "Đã đổi ảnh sản phẩm"),
    { capture: true, testId: "product-photo-capture" },
  )

  if (editing) {
    return <MobileEdit product={product} ed={ed} onClose={() => setEditing(false)} />
  }

  const rows: [string, string][] = [
    ["Thương hiệu", saved.brand || "—"],
    ...attributeDefs.map((d): [string, string] => [d.label, formatAttributeValue(saved.attributes[d.key], d)]),
    ["Màu", saved.color || "—"],
    ["Thẻ", saved.tags.join(", ") || "—"],
  ]

  function savePrice() {
    const invalid = validateDraft({ ...saved, price: priceDraft }).price
    if (invalid) {
      setPriceError(invalid)
      return
    }
    setPriceOpen(false)
    if (priceDraft !== saved.price) {
      ed.quickSave({ price: priceDraft }, priceDraft ? `Đã đổi giá thành ${money(priceDraft)}` : "Đã bỏ giá bán")
    }
  }

  return (
    <div className="-mx-4 -mt-4 flex flex-col pb-2 max-sm:-mb-2">
      <div className="relative h-[260px] bg-ax-sunken">
        {saved.image_url ? (
          <ProductCover product={{ ...product, image_url: saved.image_url }} className="size-full" />
        ) : (
          <div className="grid size-full place-items-center px-8 text-center text-sm text-ax-ink-2">Chưa có ảnh. Khách thấy ảnh đầu tiên khi xem sản phẩm.</div>
        )}
        <Link
          href="/products"
          aria-label="Quay lại Sản phẩm"
          className="absolute top-3 left-3 grid size-11 place-items-center rounded-full bg-white/90 text-ax-ink shadow-[0_1px_3px_rgba(23,24,28,.2)] focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none"
        >
          <ChevronLeft aria-hidden className="size-5" strokeWidth={2.2} />
        </Link>
        {canManage && (
          <button
            type="button"
            onClick={photo.open}
            disabled={photo.uploading}
            className="absolute right-3 bottom-3 flex h-11 cursor-pointer items-center gap-2 rounded-full bg-[rgba(23,24,28,.85)] px-4 text-[15px] font-semibold text-white focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none disabled:opacity-60"
          >
            <Camera aria-hidden className="size-[18px]" />
            {photo.uploading ? "Đang tải…" : "Chụp ảnh mới"}
          </button>
        )}
        {photo.input}
      </div>

      <div className="px-5 pt-4 pb-2">
        <h1 className="text-[22px] leading-[1.3] font-bold tracking-[-0.02em] text-ax-ink">{saved.name}</h1>
        <div className="mt-1 text-sm text-ax-ink-2">{product.code} · {categoryName}</div>
      </div>

      <div className="mx-4 mt-2 mb-3 overflow-hidden rounded-[20px] border border-[var(--ax-hero-border)] bg-ax-surface shadow-[var(--ax-shadow-hero)]">
        <HeroCard className="flex items-center justify-between gap-3 rounded-none border-0 px-[18px] pt-[18px] pb-5 shadow-none max-sm:rounded-none max-sm:p-0 max-sm:px-[18px] max-sm:pt-[18px] max-sm:pb-5">
          <div>
            <HeroCardLabel>Giá bán</HeroCardLabel>
            <HeroCardValue className="text-[32px] max-sm:text-[32px]" unit={saved.price ? "₫" : undefined}>
              {saved.price ? groupDigits(saved.price) : "Chưa có giá"}
            </HeroCardValue>
          </div>
          {canManage && (
            <Button
              type="button"
              variant="ax-on-hero"
              size="ax-lg"
              onClick={() => {
                setPriceDraft(saved.price)
                setPriceError("")
                setPriceOpen(true)
              }}
            >
              Đổi giá
            </Button>
          )}
        </HeroCard>
        <div className="flex min-h-16 items-center justify-between gap-3 px-[18px]">
          <div>
            <div id="pm-active" className="text-base font-semibold text-ax-ink">Đang bán</div>
            <div className="text-[13px] text-ax-ink-2">{saved.is_active ? "Hiện ở quầy và cửa hàng" : "Đang ẩn khỏi quầy và cửa hàng"}</div>
          </div>
          <Switch
            checked={saved.is_active}
            disabled={!canManage || ed.saving}
            aria-labelledby="pm-active"
            onCheckedChange={(v) => ed.quickSave({ is_active: v }, v ? "Đã mở bán lại" : "Đã ẩn sản phẩm")}
          />
        </div>
      </div>

      <section className="ax-card mx-4 my-2 px-4 py-1">
        {rows.map(([label, value], i) => (
          <div key={label} className={cn("flex min-h-12 items-center justify-between gap-4", i > 0 && "border-t border-ax-divider")}>
            <span className="text-[15px] text-ax-ink-2">{label}</span>
            <span className="text-right text-[15px] text-ax-ink">{value}</span>
          </div>
        ))}
      </section>
      {saved.description && <p className="mx-7 my-3 text-[15px] leading-[1.55] whitespace-pre-wrap text-ax-ink-2">{saved.description}</p>}
      {photo.error && <p role="alert" className="mx-7 text-[13px] text-ax-danger">{photo.error}</p>}

      {canManage && (
        <StickyActionBar layout="mobile">
          <Button type="button" variant="ax-primary" size="ax-lg" onClick={() => setEditing(true)}>
            Sửa toàn bộ thông tin
          </Button>
        </StickyActionBar>
      )}

      <BottomSheet open={priceOpen} onOpenChange={setPriceOpen}>
        <BottomSheetContent title="Giá bán" hideTitle>
          <div className="flex items-center justify-between">
            <BottomSheetClose render={<Button type="button" variant="ax-ghost" size="ax" />}>Huỷ</BottomSheetClose>
            <span aria-hidden className="text-base font-bold tracking-[-0.011em]">Giá bán</span>
            <Button type="button" variant="ax-ghost" size="ax" className="text-ax-primary" onClick={savePrice}>Lưu</Button>
          </div>
          <AxField
            label="Giá bán"
            className="[&>label]:sr-only"
            inputClassName="text-[22px] font-semibold tracking-[-0.02em] tabular-nums"
            inputMode="numeric"
            autoFocus
            value={groupDigits(priceDraft)}
            error={priceError || undefined}
            onChange={(e) => {
              setPriceDraft(digitsOnly(e.target.value))
              setPriceError("")
            }}
            onKeyDown={(e) => e.key === "Enter" && savePrice()}
            hint={`Giá cũ ${money(saved.price)}. Lưu xong vẫn hoàn tác được.`}
          />
        </BottomSheetContent>
      </BottomSheet>
    </div>
  )
}

function MobileEdit({ product, ed, onClose }: { product: Product; ed: ProductEditor; onClose: () => void }) {
  const { data: allCategories = [] } = useProductCategories(true)
  const categories = usableCategories(allCategories, ed.saved.category_id)
  const { draft, errors } = ed
  const categoryId = draft.category_id ? Number(draft.category_id) : null
  const { data: defs = [] } = useAttributeDefs(categoryId)
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set())
  const [tagText, setTagText] = useState(draft.tags.join(", "))
  const pick = useImagePick((url) => ed.patch({ image_url: url }))
  const dirty = ed.changes > 0

  function changeCategory(next: string) {
    const back = next === ed.saved.category_id
    ed.patch({ category_id: next, attributes: back ? ed.saved.attributes : {} })
    setInvalidKeys(new Set())
  }

  function submit() {
    if (!dirty) return
    ed.save(onClose, () => {
      const missing = findMissingRequiredAttributes(defs, draft.attributes)
      setInvalidKeys(new Set(missing))
      return missing.length > 0
    })
  }

  const chip = (selected: boolean) =>
    cn(
      "h-11 cursor-pointer rounded-full border px-4 text-[15px] font-semibold focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none",
      selected ? "border-ax-primary bg-ax-primary-soft text-ax-primary-ink" : "border-ax-btn-border bg-ax-surface text-ax-ink-2",
    )

  return (
    <div className="fixed inset-0 z-50 flex flex-col ax-page text-ax-ink">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-ax-line ax-grad-bar px-2">
        <Button type="button" variant="ax-ghost" size="ax" onClick={() => { ed.discard(); onClose() }}>Huỷ</Button>
        <h1 className="text-[17px] font-bold tracking-[-0.011em]">Sửa sản phẩm</h1>
        <Button type="button" variant="ax-ghost" size="ax" className={dirty ? "text-ax-primary" : "text-ax-ink-3"} disabled={!dirty || ed.saving} onClick={submit}>
          {ed.saving ? "Đang lưu…" : "Lưu"}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto overscroll-contain px-4 pt-4 pb-12">
        <HeroCard className="flex items-center gap-3.5 max-sm:p-4">
          <div className="size-[100px] shrink-0 overflow-hidden rounded-[12px] bg-ax-sunken shadow-[0_10px_22px_-10px_rgba(13,32,54,.6),0_0_0_1px_rgba(255,255,255,.14)]">
            {draft.image_url ? <ProductCover product={{ ...product, image_url: draft.image_url }} className="size-full" /> : <div className="grid size-full place-items-center text-xs text-ax-ink-2">Chưa có ảnh</div>}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Button type="button" variant="ax-on-hero" size="ax-lg" disabled={pick.uploading} onClick={pick.open}>
              <Camera aria-hidden className="size-[18px]" /> {pick.uploading ? "Đang tải…" : "Chụp ảnh"}
            </Button>
            {draft.image_url ? (
              <Button type="button" variant="ax-on-hero-secondary" size="ax" onClick={() => ed.patch({ image_url: "" })}>Xoá ảnh</Button>
            ) : null}
            {pick.input}
          </div>
        </HeroCard>
        {pick.error && <p role="alert" className="text-[13px] text-ax-danger">{pick.error}</p>}

        <AxField label="Tên sản phẩm" id="e-name" value={draft.name} error={errors.name} onChange={(e) => ed.patch({ name: e.target.value })} />
        <AxField label="Giá bán (₫)" id="e-price" inputMode="numeric" inputClassName="font-semibold tabular-nums" value={groupDigits(draft.price)} error={errors.price} onChange={(e) => ed.patch({ price: digitsOnly(e.target.value) })} />

        <div>
          <div id="e-cat" className="mb-1.5 text-sm font-semibold">Danh mục</div>
          <div role="radiogroup" aria-labelledby="e-cat" className="flex flex-wrap gap-2">
            {[{ id: "", name: "Chưa phân loại" }, ...categories.map((c) => ({ id: String(c.id), name: c.name }))].map((c) => (
              <button key={c.id || "none"} type="button" role="radio" aria-checked={draft.category_id === c.id} className={chip(draft.category_id === c.id)} onClick={() => changeCategory(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <DynamicAttributeFields defs={defs} values={draft.attributes} invalidKeys={invalidKeys} onChange={(k, v) => ed.patch({ attributes: { ...draft.attributes, [k]: v } })} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="e-desc" className="text-sm font-semibold">Mô tả</label>
          <textarea id="e-desc" rows={4} value={draft.description} aria-invalid={errors.description ? true : undefined} onChange={(e) => ed.patch({ description: e.target.value })} className={cn(AX_INPUT_CLASS, "h-auto w-full resize-none border px-3.5 py-3 leading-6")} />
          <div className="text-right text-[13px] text-ax-ink-3 tabular-nums">{errors.description ?? ""} {draft.description.length}/{DESCRIPTION_MAX}</div>
        </div>

        <AxField label="Thương hiệu" id="e-brand" value={draft.brand} onChange={(e) => ed.patch({ brand: e.target.value })} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="e-color" className="ax-text-label">Màu (tên hoặc mã hex)</label>
          <div className="flex items-center gap-2">
            <span className="relative size-12 flex-none overflow-hidden rounded-[10px] border border-ax-line">
              <input type="color" aria-label="Chọn màu" value={toPickerHex(draft.color)} onChange={(e) => ed.patch({ color: e.target.value })} className="absolute inset-0 size-full cursor-pointer" />
            </span>
            <AxField label="Màu" className="flex-1 [&>label]:sr-only" id="e-color" value={draft.color} error={errors.color} onChange={(e) => ed.patch({ color: e.target.value })} />
          </div>
        </div>
        <AxField
          label="Thẻ (cách nhau bằng dấu phẩy)"
          id="e-tags"
          value={tagText}
          onChange={(e) => {
            setTagText(e.target.value)
            ed.patch({ tags: commaToArray(e.target.value) })
          }}
        />
        <SwitchCard label="Nổi bật" checked={draft.is_featured} onChange={(v) => ed.patch({ is_featured: v })} />
        <SwitchCard label="Đang bán" checked={draft.is_active} onChange={(v) => ed.patch({ is_active: v })} />
      </div>
    </div>
  )
}

function SwitchCard({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId()
  return (
    <div className="ax-card flex min-h-14 items-center justify-between px-4">
      <span id={id} className="text-base font-semibold">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-labelledby={id} />
    </div>
  )
}
