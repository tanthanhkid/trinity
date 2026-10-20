import { cn } from "@/lib/utils"

/**
 * Khối giữ chỗ khi đang tải. Nhịp mờ "calm" theo Arc Library (`.skeleton-calm` trong globals.css):
 * `index` lệch nhịp từng khối để cả cụm mờ như một làn sóng.
 */
function Skeleton({ className, index, style, ...props }: React.ComponentProps<"div"> & { index?: number }) {
  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton-calm rounded-md bg-muted", className)}
      style={index != null ? ({ ...style, "--sk-index": index } as React.CSSProperties) : style}
      {...props}
    />
  )
}

export { Skeleton }
