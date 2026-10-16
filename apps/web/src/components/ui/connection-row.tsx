import type { ReactNode } from "react"

import { BRAND_LOGOS, type BrandKey } from "@/lib/brand-logos"
import { cn } from "@/lib/utils"

export type ConnectionTone = "connected" | "warning" | "off" | "soon" | "danger" | "info"

const TONE: Record<ConnectionTone, string> = {
  connected: "bg-[var(--color-app-tag-green-bg)] text-[var(--color-app-tag-green-ink)]",
  warning: "bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]",
  off: "bg-muted text-muted-foreground",
  soon: "bg-[var(--color-app-tag-slate-bg)] text-[var(--color-app-tag-slate-ink)]",
  danger: "bg-[var(--color-app-tag-red-bg)] text-[var(--color-app-tag-red-ink)]",
  info: "bg-[var(--color-app-tag-blue-bg)] text-[var(--color-app-tag-blue-ink)]",
}

/** Badge trạng thái gọn (20px, bo 6px) dùng cho dòng kết nối. */
export function StatusPill({ tone, children, className }: { tone: ConnectionTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap", TONE[tone], className)}>
      {tone === "connected" ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  )
}

/** Logo chính thức của hãng trên nền trắng (cả chế độ tối), cùng khung với ô chữ. */
export function BrandLogo({ brand, size = 36, className }: { brand: BrandKey; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      data-brand={brand}
      className={cn("flex shrink-0 items-center justify-center rounded-[10px] border border-[var(--border)] bg-white shadow-[var(--shadow-field)]", className)}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={BRAND_LOGOS[brand]} alt="" width={size} height={size} className="size-[64%] object-contain" />
    </span>
  )
}

/** Ô logo 36px: logo chính thức của hãng nếu có (`brand`), không thì chữ viết tắt / biểu tượng trên nền màu (vd webhook, tính năng của chính Trinity). */
export function ConnectionLogo({ text, color, icon, brand }: { text?: string; color: string; icon?: ReactNode; brand?: BrandKey }) {
  if (brand) return <BrandLogo brand={brand} />
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[13px] font-semibold text-white shadow-[var(--shadow-field)] [&_svg]:size-[18px]"
      style={{ backgroundColor: color }}
    >
      {icon ?? text}
    </span>
  )
}

/**
 * Một dòng kết nối kiểu "Apps › Shopify": logo · tên + mô tả xám · trạng thái · nút.
 * Điện thoại: nút xuống dòng dưới, rộng hết.
 */
export function ConnectionRow({
  logo,
  title,
  description,
  status,
  note,
  action,
  className,
  testId,
}: {
  logo: ReactNode
  title: string
  description?: ReactNode
  status?: ReactNode
  /** Dòng phụ nhỏ (vd mức đã thử với tài khoản thật). */
  note?: ReactNode
  action?: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <div data-testid={testId} className={cn("flex items-center gap-3 px-4 py-3.5 max-sm:flex-wrap", className)}>
      {logo}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {status}
        </div>
        {description ? <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</p> : null}
        {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1">{action}</div> : null}
    </div>
  )
}

/** Nhóm dòng kết nối: nhãn nhóm 13px trên thẻ trắng viền mảnh, các dòng ngăn bằng đường kẻ. */
export function ConnectionGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <h3 className="px-1 text-[13px] font-medium text-muted-foreground">{label}</h3>
      <div className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/8 shadow-[var(--shadow-card)]">{children}</div>
    </section>
  )
}
