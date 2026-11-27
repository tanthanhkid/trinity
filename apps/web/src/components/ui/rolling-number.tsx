"use client"

/**
 * Số liệu "lăn" — vỏ mỏng: lúc đầu hiện thẳng chuỗi, thư viện chuyển động (`motion`, ~40 kB gzip)
 * nạp ở chunk riêng SAU khi trang đã vẽ (không nằm trong JS lần đầu của mọi trang). Cách lăn ở
 * `rolling-number-impl.tsx`.
 */
import { useEffect, useState, type ComponentType } from "react"
import { rollingParts } from "./rolling-parts"

export { rollingParts }

type Props = { text: string; className?: string }
let loaded: ComponentType<Props> | null = null
let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= import("./rolling-number-impl").then((m) => {
    loaded = m.RollingNumberImpl
  })
  return loading
}

export function RollingNumber({ text, className }: Props) {
  const [Impl, setImpl] = useState<ComponentType<Props> | null>(() => loaded)
  useEffect(() => {
    if (Impl || !parts(text)) return
    let live = true
    const start = () => void load().then(() => live && setImpl(() => loaded))
    const ric = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
    if (ric) ric(start)
    else setTimeout(start, 200)
    return () => {
      live = false
    }
  }, [Impl, text])
  if (Impl) return <Impl text={text} className={className} />
  return <span className={className}>{text}</span>
}

function parts(text: string): boolean {
  return rollingParts(text).some((p) => "digit" in p)
}
