import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Opts = { duration?: number; action?: { label: string; onClick: () => void } }
const calls: { message: string; opts?: Opts }[] = []
vi.mock("sonner", () => {
  const toast = Object.assign((message: string) => calls.push({ message }), {
    success: (message: string, opts?: Opts) => calls.push({ message, opts }),
  })
  return { toast }
})

import { deferWithUndo, flushUndoables, toastWithUndo, UNDO_WINDOW_MS } from "@/lib/undo"

const lastAction = () => calls.filter((c) => c.opts?.action).at(-1)!.opts!.action!

describe("hoàn tác 5 giây", () => {
  beforeEach(() => { vi.useFakeTimers(); calls.length = 0 })
  afterEach(() => { vi.useRealTimers() })

  it("deferWithUndo: chưa gửi lên máy chủ trong 5 giây; hết hạn mới gửi", () => {
    const commit = vi.fn()
    deferWithUndo({ message: "Đã xoá 2 khách hàng", commit, onUndo: vi.fn() })
    expect(calls[0]).toMatchObject({ message: "Đã xoá 2 khách hàng", opts: { duration: UNDO_WINDOW_MS, action: { label: "Hoàn tác" } } })
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledOnce()
  })

  it("bấm Hoàn tác trong 5 giây ⇒ không bao giờ gửi, gọi onUndo, báo đã hoàn tác", () => {
    const commit = vi.fn()
    const onUndo = vi.fn()
    deferWithUndo({ message: "Đã xoá card", commit, onUndo })
    lastAction().onClick()
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2)
    expect(commit).not.toHaveBeenCalled()
    expect(onUndo).toHaveBeenCalledOnce()
    expect(calls.at(-1)!.message).toBe("Đã hoàn tác")
  })

  it("đóng tab trong lúc chờ ⇒ gửi ngay, không gửi lần hai", () => {
    const commit = vi.fn()
    deferWithUndo({ message: "x", commit, onUndo: vi.fn() })
    flushUndoables()
    expect(commit).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(UNDO_WINDOW_MS)
    lastAction().onClick()
    expect(commit).toHaveBeenCalledOnce()
  })

  it("toastWithUndo: Hoàn tác gọi thao tác ngược đúng một lần", () => {
    const onUndo = vi.fn()
    toastWithUndo({ message: "Đã chuyển “A” sang Đang làm", onUndo })
    lastAction().onClick()
    lastAction().onClick()
    expect(onUndo).toHaveBeenCalledOnce()
  })
})
