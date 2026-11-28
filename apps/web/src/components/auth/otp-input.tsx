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
  // Ô trống giữ chỗ bằng dấu cách: sửa/xoá một ô không làm dồn các ô sau.
  const digits = Array.from({ length }, (_, i) => (/\d/.test(value[i] ?? "") ? value[i] : ""))

  function emit(next: string[]) {
    const v = next.map((d) => d || " ").join("").replace(/\s+$/, "")
    onChange(v)
    if (isCompleteCode(v, length)) onComplete?.(v)
  }

  function focus(i: number) {
    refs.current[Math.max(0, Math.min(length - 1, i))]?.focus()
  }

  /** Điền cả chuỗi số từ ô `from` (dán, bàn phím tự điền mã). */
  function spread(from: number, nums: string) {
    const next = [...digits]
    const start = nums.length >= length ? 0 : from
    for (let k = 0; k < nums.length && start + k < length; k++) next[start + k] = nums[k]
    emit(next)
    focus(Math.min(start + nums.length, length - 1))
  }

  function onInput(i: number, raw: string) {
    const nums = raw.replace(/\D/g, "")
    const next = [...digits]
    if (!nums) {
      // Xoá không qua phím Backspace (IME Android, Delete, cắt): xoá đúng ô i.
      next[i] = ""
      emit(next)
      return
    }
    if (nums.length > 2) return spread(i, nums)
    if (nums.length === 2) {
      // Ô đang có số và con trỏ không chọn hết: lấy ký tự MỚI (khác số cũ), không chèn cả hai.
      const old = digits[i]
      next[i] = nums[0] === old ? nums[1] : nums[1] === old ? nums[0] : nums[1]
    } else {
      next[i] = nums
    }
    emit(next)
    focus(i + 1)
  }

  function onKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault()
      const next = [...digits]
      if (digits[i]) {
        next[i] = ""
      } else if (i > 0) {
        next[i - 1] = ""
        focus(i - 1)
      }
      emit(next)
    } else if (e.key === "ArrowLeft") {
      e.preventDefault()
      focus(i - 1)
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      focus(i + 1)
    }
  }

  function onPaste(i: number, e: ClipboardEvent<HTMLInputElement>) {
    const nums = e.clipboardData.getData("text").replace(/\D/g, "")
    if (!nums) return
    e.preventDefault()
    spread(i, nums)
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
          onPaste={(e) => onPaste(i, e)}
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

/** Đủ `length` chữ số, không ô trống. */
export function isCompleteCode(v: string, length = 6): boolean {
  return v.length === length && /^\d+$/.test(v)
}
