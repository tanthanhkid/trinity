"use client"

import { useRef, type ClipboardEvent, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import { AX_INPUT_CLASS } from "@/components/ui/input"

/**
 * Ô nhập mã 6 số (#675) theo dáng ô «Ánh xanh»: dán một lần là điền đủ, gõ đủ 6 số thì tự gửi (`onComplete`), Backspace lùi
 * ô, phím mũi tên đi qua lại. Ô đầu mang `autoComplete="one-time-code"` để iOS/Android gợi ý mã từ tin nhắn/thư.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  invalid,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  onComplete?: (v: string) => void
  length?: number
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = Array.from({ length }, (_, i) => value[i] ?? "")

  function commit(next: string) {
    const clean = next.replace(/\D/g, "").slice(0, length)
    onChange(clean)
    if (clean.length === length) onComplete?.(clean)
    return clean
  }

  function focus(i: number) {
    refs.current[Math.max(0, Math.min(length - 1, i))]?.focus()
  }

  function onInput(i: number, raw: string) {
    const typed = raw.replace(/\D/g, "")
    if (!typed) return
    // Gõ một số ⇒ đặt vào ô i; bàn phím điện thoại tự điền cả mã vào một ô ⇒ trải ra các ô sau.
    const before = value.slice(0, i)
    const next = commit((before + typed).slice(0, length))
    focus(Math.min(next.length, length - 1))
  }

  function onKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault()
      if (digits[i]) {
        commit(value.slice(0, i) + value.slice(i + 1))
      } else if (i > 0) {
        commit(value.slice(0, i - 1) + value.slice(i))
        focus(i - 1)
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault()
      focus(i - 1)
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      focus(i + 1)
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text")
    const only = text.replace(/\D/g, "")
    if (!only) return
    e.preventDefault()
    const next = commit(only)
    focus(Math.min(next.length, length - 1))
  }

  return (
    <div role="group" aria-label={`Mã ${length} số`} className="flex justify-between gap-2">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          value={d}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoFocus={autoFocus && i === 0}
          maxLength={length}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-label={`Chữ số ${i + 1}`}
          className={cn(
            AX_INPUT_CLASS,
            "h-12 max-sm:h-14 pointer-coarse:h-14 w-full min-w-0 px-0 text-center text-xl max-sm:text-xl font-semibold tabular-nums outline-none disabled:opacity-60",
          )}
        />
      ))}
    </div>
  )
}
