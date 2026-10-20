"use client"

/**
 * Số liệu "lăn" như đồng hồ công-tơ-mét — phỏng theo `animated-counter` của Arc Library
 * (https://github.com/kuratlielia/arc-library, MIT License, Copyright (c) 2026 Elia Kuratli).
 *
 * Khác bản gốc: nhận CHUỖI đã định dạng sẵn ("140.253.800 ₫", "42%", "6,4 triệu") để giữ nguyên
 * cách định dạng tiếng Việt của Trinity — chỉ các chữ số lăn, dấu và chữ đứng yên. Mỗi chữ số là
 * một bánh xe khoá theo hàng (hàng đơn vị luôn là hàng đơn vị), lần đầu lọt vào màn hình thì lăn
 * từ 0 lên; giá trị đổi thì lăn theo chiều tăng/giảm. Giảm chuyển động: hiện thẳng số.
 */
import { useEffect, useRef, useState } from "react"
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react"
import { motionTokens } from "@/lib/motion-tokens"
import { cn } from "@/lib/utils"

type Part = { key: string; digit: number; order: number } | { key: string; text: string }

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const STAGGER = 0.035
const reveal = { ...motionTokens.spring.smooth, visualDuration: motionTokens.duration.considered }

/** Tách chuỗi thành chữ số (khoá theo hàng tính từ phải sang của cụm số đầu tiên) và phần chữ còn lại. */
export function rollingParts(text: string): Part[] {
  const digitsTotal = (text.match(/\d/g) ?? []).length
  let place = digitsTotal
  let order = 0
  return Array.from(text).map((ch, i): Part => {
    if (/\d/.test(ch)) return { key: `d${--place}`, digit: Number(ch), order: order++ }
    return { key: `t${i}-${ch}`, text: ch }
  })
}

/** Số trong chuỗi (bỏ dấu nhóm) — chỉ để biết giá trị tăng hay giảm. */
function amountOf(text: string): number {
  const n = Number(text.replace(/[^\d,-]/g, "").replace(",", "."))
  return Number.isFinite(n) ? n : 0
}

function Glyph({ position, digit }: { position: MotionValue<number>; digit: number }) {
  const offset = useTransform(position, (current) => ((((digit - current) % 10) + 15) % 10) - 5)
  const y = useTransform(offset, (current) => `${current}em`)
  const opacity = useTransform(offset, (current) => Math.max(0, 1 - Math.abs(current)))
  const visibility = useTransform(offset, (current) => (Math.abs(current) >= 1 ? "hidden" : "visible"))
  return (
    <motion.span className="absolute inset-x-0 top-[var(--feather)] text-center" style={{ y, opacity, visibility }}>
      {digit}
    </motion.span>
  )
}

/** Một bánh xe chữ số — luôn quay theo chiều cả con số đổi, 9 → 0 vòng qua như công-tơ-mét. */
function Column({ digit, direction, armed, delay, reduceMotion }: { digit: number; direction: number; armed: boolean; delay: number; reduceMotion: boolean }) {
  const position = useMotionValue(armed ? 0 : digit)
  const wheel = useRef({ digit: armed ? 0 : digit, target: armed ? 0 : digit, revealed: !armed })
  useEffect(() => {
    const state = wheel.current
    if (armed || state.digit === digit) {
      if (!armed) state.revealed = true
      return
    }
    state.target += direction < 0 && state.revealed ? -((state.digit - digit + 10) % 10) : (digit - state.digit + 10) % 10
    state.digit = digit
    if (reduceMotion) position.jump(state.target)
    else animate(position, state.target, state.revealed ? motionTokens.spring.smooth : { ...reveal, delay })
    state.revealed = true
  }, [armed, delay, digit, direction, position, reduceMotion])
  return (
    <span
      className="relative inline-block overflow-hidden [--feather:.16em] [margin-block:calc(var(--feather)*-1)] [padding-block:var(--feather)] [mask-image:linear-gradient(to_bottom,transparent,#000_calc(var(--feather)*1.5),#000_calc(100%-var(--feather)*1.5),transparent)]"
    >
      <span className="invisible">0</span>
      {DIGITS.map((d) => (
        <Glyph key={d} position={position} digit={d} />
      ))}
    </span>
  )
}

/** Đã lọt vào màn hình lần nào chưa. Không có IntersectionObserver (máy cũ, môi trường test) thì coi như đã thấy. */
function useSeenOnce(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    const node = ref.current
    if (seen || !node || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true)
        io.disconnect()
      }
    }, { threshold: 0.6 })
    io.observe(node)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

export function RollingNumber({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useSeenOnce(ref)
  const reduceMotion = !!useReducedMotion()
  const [previous, setPrevious] = useState(text)
  const [direction, setDirection] = useState(1)
  if (text !== previous) {
    setPrevious(text)
    setDirection(amountOf(text) >= amountOf(previous) ? 1 : -1)
  }
  const parts = rollingParts(text)
  // Không có chữ số (vd "—") thì khỏi dựng bánh xe.
  if (!parts.some((p) => "digit" in p)) return <span className={className}>{text}</span>
  return (
    <span ref={ref} className={cn("relative inline-flex tabular-nums", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex select-none items-start whitespace-pre">
        {parts.map((p) =>
          "digit" in p ? (
            <Column key={p.key} digit={p.digit} direction={direction} armed={!inView} delay={Math.min(p.order * STAGGER, 0.25)} reduceMotion={reduceMotion} />
          ) : (
            <span key={p.key} className="inline-block">
              {p.text}
            </span>
          ),
        )}
      </span>
    </span>
  )
}
