import type { SocialNetwork } from "@/hooks/use-social"
import { cn } from "@/lib/utils"

/** Nhãn + màu từng mạng — ô chữ màu thương hiệu, không dùng logo của bên thứ ba. */
export const NETWORK_META: Record<SocialNetwork, { label: string; color: string; text: string }> = {
  facebook: { label: "Facebook", color: "#1877F2", text: "f" },
  instagram: { label: "Instagram", color: "#E1306C", text: "IG" },
  youtube: { label: "YouTube", color: "#FF0033", text: "YT" },
  tiktok: { label: "TikTok", color: "#111111", text: "TT" },
  google_business: { label: "Google Business", color: "#4285F4", text: "G" },
}

export function NetworkMark({ network, size = "md", className }: { network: SocialNetwork; size?: "sm" | "md"; className?: string }) {
  const m = NETWORK_META[network] ?? { label: network, color: "#64748b", text: String(network).slice(0, 2).toUpperCase() }
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
