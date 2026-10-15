import { afterEach, describe, expect, it, vi } from "vitest"
import { inboxPollMs, nextTickMs } from "@/lib/realtime-mode"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("nextTickMs — hẹn lượt nhắc máy chủ theo việc chờ sớm nhất", () => {
  const now = Date.parse("2026-10-15T03:00:00Z")
  it("không còn gì chờ ⇒ 10 phút; việc đang chạy ⇒ 60 giây", () => {
    expect(nextTickMs({ due: false, next_at: null }, now)).toBe(600_000)
    expect(nextTickMs(undefined, now)).toBe(60_000) // lỗi / chưa có dữ liệu ⇒ thử lại sau 60 giây
    expect(nextTickMs({ due: true, next_at: null }, now)).toBe(60_000)
  })
  it("có bài hẹn ⇒ đúng giờ đó (+2 giây), kẹp trong 20 giây … 10 phút", () => {
    expect(nextTickMs({ due: false, next_at: "2026-10-15T03:05:00Z" }, now)).toBe(302_000)
    expect(nextTickMs({ due: false, next_at: "2026-10-15T02:59:00Z" }, now)).toBe(20_000)
    expect(nextTickMs({ due: false, next_at: "2026-10-16T03:00:00Z" }, now)).toBe(600_000)
    expect(nextTickMs({ due: false, next_at: "không phải ngày" }, now)).toBe(600_000)
  })
})

describe("inboxPollMs — giãn nhịp hộp thư trên bản serverless", () => {
  it("VPS giữ nhịp cũ; Vercel: danh sách 60 giây, hội thoại đang mở 20 giây", () => {
    expect(inboxPollMs("list", 15_000)).toBe(15_000)
    vi.stubEnv("NEXT_PUBLIC_REALTIME_MODE", "poll")
    expect(inboxPollMs("list", 15_000)).toBe(60_000)
    expect(inboxPollMs("thread", 8_000)).toBe(20_000)
  })
})
