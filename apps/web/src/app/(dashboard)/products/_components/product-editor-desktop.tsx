"use client"

/**
 * Trang sửa sản phẩm trên máy tính (≥1024px) — «Ánh xanh», thiết kế sanpham-desktop:
 * breadcrumb + chip trạng thái; cột trái 2 thẻ (Cơ bản có ảnh 240, Chi tiết); cột phải dính: khối nhấn «Khách sẽ thấy»
 * + thẻ «Sẵn sàng bán x/4»; thanh tối nổi «Có n thay đổi chưa lưu» (Bỏ thay đổi / Lưu); lưu xong có toast Hoàn tác.
 * Chỉ đọc (không có `products.manage`): ô khoá, không hiện thanh lưu.
 */
import { useState } from "react"
import { ImagePlus, Trash2, X } from "lucide-react"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { AxField } from "@/components/ui/field"
import { AX_INPUT_CLASS, Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { StageChip } from "@/components/ui/stage-chip"
import { HeroCard, HeroCardLabel, HeroCardValue } from "@/components/ui/hero-card"
import { useActiveProjects } from "@/hooks/use-projects"
import { useAttributeDefs, useProductCategories } from "@/hooks/products/use-product-categories"
import { cn } from "@/lib/utils"
import type { Product } from "@/types/product"
import {
  DESCRIPTION_MAX,
  digitsOnly,
  groupDigits,
  readiness,
} from "./product-draft"
import { DynamicAttributeFields, findMissingRequiredAttributes } from "./dynamic-attribute-fields"
import { ProductCover } from "./product-cover"
import { toPickerHex } from "./product-form-schema"
import { useImagePick } from "./use-image-pick"
import { useProductEditor } from "./use-product-editor"

const CARD = "ax-card p-6 max-xl:p-5"
const NONE = ""

function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-[15px] font-bold tracking-[-0.011em] text-ax-ink">
      {children}
    </h2>
  )
}

export function ProductEditorDesktop({ product, canManage }: { product: Product; canManage: boolean }) {
  const { data: categories = [] } = useProductCategories(true)
  const { data: projects = [] } = useActiveProjects()
  const [invalidKeys, setInvalidKeys] = useState<Set<string>>(new Set())
  const ed = useProductEditor(product)
  const { draft, errors } = ed
  const categoryId = draft.category_id ? Number(draft.category_id) : null
  const { data: attributeDefs = [] } = useAttributeDefs(categoryId)

  const pick = useImagePick((url) => ed.patch({ image_url: url }))
  const ready = readiness(draft)
  const readyN = ready.filter((r) => r.ok).length
  const disabled = !canManage
  const project = projects.find((p) => p.id === product.project_id)
  const colorValid = typeof CSS !== "undefined" && draft.color && CSS.supports?.("color", draft.color)

  /** Thiếu thuộc tính bắt buộc ⇒ đánh dấu ô và chặn lưu. */
  function missingRequired(): boolean {
    const missing = findMissingRequiredAttributes(attributeDefs, draft.attributes)
    setInvalidKeys(new Set(missing))
    return missing.length > 0
  }

  function changeCategory(next: string) {
    // Đổi danh mục ⇒ thuộc tính cũ không còn khớp def mới (BE sẽ 400); quay về danh mục gốc ⇒ khôi phục.
    const back = next === ed.saved.category_id
    ed.patch({ category_id: next, attributes: back ? ed.saved.attributes : {} })
    setInvalidKeys(new Set())
  }

  function addTag(raw: string) {
    const v = raw.trim()
    if (v && !draft.tags.includes(v)) ed.patch({ tags: [...draft.tags, v] })
  }

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Vị trí" className="flex min-w-0 items-center gap-2 text-[13px] text-ax-ink-2">
          <Link href="/products" className="rounded-sm underline-offset-2 hover:underline focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none">
            Sản phẩm
          </Link>
          <span aria-hidden>/</span>
          <span className="truncate text-ax-ink">{draft.name || product.name}</span>
        </nav>
        <StageChip tone={draft.is_active ? "won" : "neutral"}>{draft.is_active ? "Đang bán" : "Đang ẩn"}</StageChip>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[3_1_560px] flex-col gap-4">
          <section aria-labelledby="pe-basic" className={cn(CARD, "flex flex-wrap gap-6")}>
            <div className="flex flex-[0_0_240px] flex-col gap-2.5">
              <div className="flex size-[240px] items-center justify-center overflow-hidden rounded-ax-card border border-ax-line bg-ax-sunken shadow-[var(--ax-shadow-inset)]">
                {draft.image_url ? (
                  <ProductCover product={{ ...product, image_url: draft.image_url }} className="size-full" />
                ) : (
                  <p className="p-4 text-center text-sm leading-6 text-ax-ink-2">
                    Chưa có ảnh.
                    <br />
                    Khách thấy ảnh đầu tiên khi xem sản phẩm.
                  </p>
                )}
              </div>
              {!disabled && (
                <div className="flex gap-2">
                  <Button type="button" variant="ax-secondary" size="ax-lg" className="flex-1" disabled={pick.uploading} onClick={pick.open}>
                    <ImagePlus aria-hidden className="size-4" />
                    {pick.uploading ? "Đang tải…" : draft.image_url ? "Thay ảnh" : "Chọn ảnh từ máy"}
                  </Button>
                  {draft.image_url && (
                    <Button type="button" variant="ax-danger" size="ax-icon" aria-label="Xoá ảnh" onClick={() => ed.patch({ image_url: "" })}>
                      <Trash2 aria-hidden className="size-[18px]" />
                    </Button>
                  )}
                  {pick.input}
                </div>
              )}
              {pick.error && <p role="alert" className="text-[13px] text-ax-danger">{pick.error}</p>}
              <p className="text-[13px] leading-5 text-ax-ink-2">
                Ảnh chụp bằng điện thoại: mở Trinity trên điện thoại, vào sản phẩm này và bấm Chụp ảnh.
              </p>
            </div>

            <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
              <SectionTitle id="pe-basic">Cơ bản</SectionTitle>
              <AxField label="Tên sản phẩm" id="p-name" value={draft.name} disabled={disabled} error={errors.name} onChange={(e) => ed.patch({ name: e.target.value })} />
              <div className="flex flex-wrap gap-3">
                <AxField
                  className="flex-[1_1_160px]"
                  label="Giá bán (₫)"
                  id="p-price"
                  inputMode="numeric"
                  inputClassName="font-semibold tabular-nums"
                  value={groupDigits(draft.price)}
                  disabled={disabled}
                  error={errors.price}
                  onChange={(e) => ed.patch({ price: digitsOnly(e.target.value) })}
                />
                <AxField
                  className="flex-[1_1_160px]"
                  label="Mã sản phẩm"
                  id="p-code"
                  value={product.code}
                  disabled
                  hint="Mã không đổi được sau khi tạo"
                  readOnly
                />
              </div>
              <div className="flex flex-col gap-1">
                <SwitchRow label="Đang bán" hint="Tắt thì sản phẩm ẩn khỏi quầy và cửa hàng" checked={draft.is_active} disabled={disabled} onChange={(v) => ed.patch({ is_active: v })} />
                <SwitchRow label="Nổi bật" hint="Đưa lên đầu danh sách" checked={draft.is_featured} disabled={disabled} onChange={(v) => ed.patch({ is_featured: v })} />
              </div>
            </div>
          </section>

          <section aria-labelledby="pe-detail" className={cn(CARD, "grid grid-cols-2 gap-x-5 gap-y-4 max-xl:grid-cols-1")}>
            <div className="col-span-full">
              <SectionTitle id="pe-detail">Chi tiết</SectionTitle>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="p-cat" className="ax-text-label">Danh mục / ngành</label>
              <select
                id="p-cat"
                value={draft.category_id}
                disabled={disabled}
                onChange={(e) => changeCategory(e.target.value)}
                className={cn(AX_INPUT_CLASS, "w-full border px-3")}
              >
                <option value={NONE}>Chưa phân loại</option>
                {categories.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
            </div>
            <AxField label="Thương hiệu" id="p-brand" value={draft.brand} disabled={disabled} onChange={(e) => ed.patch({ brand: e.target.value })} />
            {attributeDefs.length > 0 && (
              <div className="col-span-full">
                <DynamicAttributeFields
                  defs={attributeDefs}
                  values={draft.attributes}
                  invalidKeys={invalidKeys}
                  onChange={(key, value) => ed.patch({ attributes: { ...draft.attributes, [key]: value } })}
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="p-color" className="ax-text-label">Màu</label>
              <div className="flex items-center gap-2">
                <span className="relative size-10 flex-none overflow-hidden rounded-[10px] border border-ax-line">
                  <span aria-hidden className="absolute inset-0" style={{ backgroundColor: colorValid ? draft.color : "var(--ax-line)" }} />
                  <input
                    type="color"
                    aria-label="Chọn màu"
                    disabled={disabled}
                    value={toPickerHex(draft.color)}
                    onChange={(e) => ed.patch({ color: e.target.value })}
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                  />
                </span>
                <Input id="p-color" variant="ax" placeholder="Tên màu hoặc mã hex" value={draft.color} disabled={disabled} aria-invalid={errors.color ? true : undefined} onChange={(e) => ed.patch({ color: e.target.value })} />
              </div>
              {errors.color && <p role="alert" className="text-[13px] text-ax-danger">{errors.color}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="p-tag" className="ax-text-label">Thẻ</label>
              <Input
                id="p-tag"
                variant="ax"
                placeholder="Gõ thẻ rồi nhấn Enter"
                disabled={disabled}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addTag(e.currentTarget.value)
                    e.currentTarget.value = ""
                  }
                }}
                onBlur={(e) => {
                  addTag(e.currentTarget.value)
                  e.currentTarget.value = ""
                }}
              />
              {draft.tags.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {draft.tags.map((t) => (
                    <li key={t} className="flex h-8 items-center gap-0.5 rounded-full bg-ax-sunken pr-1 pl-3 text-[13px] text-ax-ink">
                      {t}
                      {!disabled && (
                        <button
                          type="button"
                          aria-label={`Bỏ thẻ ${t}`}
                          onClick={() => ed.patch({ tags: draft.tags.filter((x) => x !== t) })}
                          className="relative grid size-7 cursor-pointer place-items-center rounded-full text-ax-ink-2 hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none after:absolute after:top-1/2 after:left-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2"
                        >
                          <X aria-hidden className="size-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="p-project" className="ax-text-label">Dự án</label>
              <Input id="p-project" variant="ax" disabled readOnly value={project?.name ?? (product.project_id != null ? `#${product.project_id}` : "Không thuộc dự án")} />
            </div>
            <div className="col-span-full flex flex-col gap-1.5">
              <label htmlFor="p-desc" className="ax-text-label">Mô tả</label>
              <textarea
                id="p-desc"
                rows={5}
                value={draft.description}
                disabled={disabled}
                aria-invalid={errors.description ? true : undefined}
                onChange={(e) => ed.patch({ description: e.target.value })}
                className={cn(AX_INPUT_CLASS, "h-auto w-full resize-y border py-2.5 leading-6 disabled:cursor-not-allowed disabled:opacity-60")}
              />
              <div className="text-right text-[13px] text-ax-ink-3 tabular-nums">
                {errors.description ? <span role="alert" className="mr-2 text-ax-danger">{errors.description}</span> : null}
                {draft.description.length}/{DESCRIPTION_MAX}
              </div>
            </div>
          </section>
        </div>

        <aside className="sticky top-4 flex min-w-[280px] max-w-[380px] flex-[1_1_300px] flex-col gap-4">
          <HeroCard compact={false} className="rounded-[14px] p-4 pb-[18px] max-sm:p-4">
            <HeroCardLabel className="mb-3 text-[11px] font-semibold tracking-[0.06em] uppercase">Khách sẽ thấy</HeroCardLabel>
            <div className="h-[168px] overflow-hidden rounded-[10px] bg-ax-sunken shadow-[0_10px_22px_-10px_rgba(13,32,54,.6),0_0_0_1px_rgba(255,255,255,.14)]">
              {draft.image_url ? (
                <ProductCover product={{ ...product, image_url: draft.image_url }} className="size-full" />
              ) : (
                <div className="grid size-full place-items-center px-4 text-center text-sm text-ax-ink-2">Chưa có ảnh</div>
              )}
            </div>
            <div className="mt-3.5 text-[15px] leading-[1.35] font-semibold text-white">{draft.name || "Chưa đặt tên"}</div>
            <HeroCardValue className="mt-0.5 text-[28px] max-sm:text-[28px]" unit={draft.price ? "₫" : undefined}>
              {draft.price ? groupDigits(draft.price) : "Chưa có giá"}
            </HeroCardValue>
          </HeroCard>
          <section className="ax-card px-[18px] py-4" aria-labelledby="pe-ready">
            <h2 id="pe-ready" className="mb-2 text-sm font-bold tracking-[-0.011em] text-ax-ink">Sẵn sàng bán {readyN}/4</h2>
            <ul className="flex flex-col gap-1.5">
              {ready.map((r) => (
                <li key={r.label} className={cn("flex items-center gap-2.5 text-sm", r.ok ? "text-ax-ink" : "text-ax-ink-2")}>
                  <span aria-hidden className={cn("grid size-[18px] place-items-center rounded-full text-[11px] font-bold text-white", r.ok ? "bg-ax-success" : "bg-ax-btn-border")}>
                    {r.ok ? "✓" : ""}
                  </span>
                  <span className="sr-only">{r.ok ? "Đã có: " : "Chưa có: "}</span>
                  {r.label}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {canManage && ed.changes > 0 && (
        <div
          role="region"
          aria-label="Thay đổi chưa lưu"
          className="fixed bottom-6 left-1/2 z-30 flex w-[min(760px,calc(100%-48px))] -translate-x-1/2 items-center justify-between gap-3 rounded-[16px] py-2.5 pr-2.5 pl-5 text-white ax-grad-toast shadow-[var(--ax-shadow-float)]"
        >
          <span className="text-sm" aria-live="polite">Có {ed.changes} thay đổi chưa lưu</span>
          <span className="flex gap-2">
            <Button type="button" variant="ax-on-hero-secondary" size="ax" onClick={ed.discard}>Bỏ thay đổi</Button>
            <Button type="button" variant="ax-on-hero" size="ax" disabled={ed.saving} onClick={() => ed.save(undefined, missingRequired)}>
              {ed.saving ? "Đang lưu…" : "Lưu"}
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}

function SwitchRow({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <div>
        <div id={`sw-${label}`} className="text-[15px] font-semibold text-ax-ink">{label}</div>
        <div className="text-[13px] text-ax-ink-2">{hint}</div>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-labelledby={`sw-${label}`} />
    </div>
  )
}
