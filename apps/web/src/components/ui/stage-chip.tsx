import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Chip giai đoạn «Ánh xanh» (docs/design/anh-xanh.md): chấm 6px màu đậm + nền nhạt + chữ đậm
 * cùng tông, bo 999, cao 24 (`sm`) / 28 (`md`), không viền.
 *
 * Màu lấy theo `tone` (5 tông của hệ thiết kế + `neutral`). Giai đoạn do người dùng tự đặt
 * màu (cột Kanban có `color` tự do) thì truyền `dotColor`: chấm theo màu đó, nền/chữ trung
 * tính — KHÔNG tô nền theo màu tự do vì không bảo đảm được tương phản chữ.
 *
 * Bấm được khi có `onClick` (render `<button>`, `aria-pressed` theo `selected`; vùng chạm
 * mở rộng tới 44px bằng `::after`). `selected` = gradient dọc 2 sắc cùng tông + viền mảnh.
 *
 * @example
 * <StageChip tone="quote">Báo giá</StageChip>
 * <StageChip dotColor={column.color} selected={active} onClick={() => pick(column.id)}>{column.name}</StageChip>
 */
export type StageTone = "new" | "consult" | "quote" | "won" | "care" | "neutral"

export const STAGE_TONES: readonly StageTone[] = ["new", "consult", "quote", "won", "care", "neutral"]

/** Biến CSS của từng tông (khai ở `app/globals.css`, khối «Ánh xanh»). */
export function stageToneVars(tone: StageTone): { dot: string; bg: string; ink: string } {
  if (tone === "neutral") {
    return { dot: "var(--ax-ink-3)", bg: "var(--ax-sunken)", ink: "var(--ax-ink-2)" }
  }
  return {
    dot: `var(--ax-stage-${tone}-dot)`,
    bg: `var(--ax-stage-${tone}-bg)`,
    ink: `var(--ax-stage-${tone}-ink)`,
  }
}

type StageChipProps = Omit<React.ComponentProps<"span">, "onClick"> & {
  tone?: StageTone
  /** Màu chấm tự do (vd `column.color`) — nền/chữ khi đó theo tông `neutral`. */
  dotColor?: string | null
  size?: "sm" | "md"
  selected?: boolean
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
}

export function StageChip({
  tone = "neutral",
  dotColor,
  size = "md",
  selected = false,
  onClick,
  disabled,
  className,
  style,
  children,
  ...props
}: StageChipProps) {
  const vars = stageToneVars(dotColor ? "neutral" : tone)
  const dot = dotColor || vars.dot
  const cssVars = {
    "--chip-bg": vars.bg,
    "--chip-ink": vars.ink,
    "--chip-dot": dot,
    ...style,
  } as React.CSSProperties
  const cls = cn(
    "relative inline-flex max-w-full shrink-0 items-center gap-2 rounded-[var(--ax-radius-chip)] font-semibold whitespace-nowrap",
    "bg-[color:var(--chip-bg)] text-[var(--chip-ink)]",
    size === "sm" ? "h-6 px-2.5 text-[12px]" : "h-7 px-3 text-[13px]",
    selected &&
      "bg-[image:linear-gradient(180deg,color-mix(in_srgb,#ffffff_45%,var(--chip-bg))_0%,var(--chip-bg)_100%)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--chip-dot)_45%,transparent)]",
    className,
  )
  const content = (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--chip-dot)]" />
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        data-slot="stage-chip"
        data-tone={dotColor ? "custom" : tone}
        {...(props as unknown as React.ComponentProps<"button">)}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onClick}
        style={cssVars}
        className={cn(
          cls,
          "cursor-pointer transition-[background-color,box-shadow] duration-150 outline-none hover:brightness-[0.97] focus-visible:shadow-[var(--ax-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45",
          "after:absolute after:top-1/2 after:left-1/2 after:h-11 after:w-[max(100%,44px)] after:-translate-x-1/2 after:-translate-y-1/2",
        )}
      >
        {content}
      </button>
    )
  }
  return (
    <span data-slot="stage-chip" data-tone={dotColor ? "custom" : tone} style={cssVars} className={cls} {...props}>
      {content}
    </span>
  )
}
