import type { SocialNetwork } from "@/hooks/use-social"
import { BRAND_LOGOS, type BrandKey } from "@/lib/brand-logos"
import { cn } from "@/lib/utils"

/** Nhãn + logo chính thức từng mạng (`public/brand/logos/SOURCES.md`); `color`/`text` chỉ còn làm dự phòng cho mạng lạ. */
export const NETWORK_META: Record<SocialNetwork, { label: string; color: string; text: string; brand: BrandKey }> = {
  facebook: { label: "Facebook", color: "#1877F2", text: "f", brand: "facebook" },
  instagram: { label: "Instagram", color: "#E1306C", text: "IG", brand: "instagram" },
  youtube: { label: "YouTube", color: "#FF0033", text: "YT", brand: "youtube" },
  tiktok: { label: "TikTok", color: "#111111", text: "TT", brand: "tiktok" },
  google_business: { label: "Google Business", color: "#4285F4", text: "G", brand: "google_business" },
}

export function NetworkMark({ network, size = "md", className }: { network: SocialNetwork; size?: "sm" | "md"; className?: string }) {
  const m = NETWORK_META[network] ?? { label: network, color: "#64748b", text: String(network).slice(0, 2).toUpperCase() }
  if ("brand" in m && m.brand) {
    return (
      <span
        aria-hidden
        data-brand={m.brand}
        className={cn(
          "inline-flex shrink-0 items-center justify-center border border-[var(--border)] bg-white",
          size === "md" ? "size-7 rounded-lg" : "size-4 rounded-[5px]",
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- logo tĩnh trong /public */}
        <img src={BRAND_LOGOS[m.brand]} alt="" className="size-[70%] object-contain" />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold text-white",
        size === "md" ? "size-7 rounded-lg text-[11px]" : "size-4 rounded-[5px] text-[8px]",
        className,
      )}
      style={{ backgroundColor: m.color }}
    >
      {m.text}
    </span>
  )
}
