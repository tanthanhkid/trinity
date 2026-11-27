import { describe, expect, it } from "vitest"
import {
  ChunkAborted,
  isFatalChunkError,
  resumeKey,
  uploadVideoInChunks,
  type ChunkStorage,
  type ChunkTransport,
} from "@/lib/social-chunk-upload"

function memStorage(): ChunkStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

/** Máy chủ giả: nhớ phần đã nhận; `failPut(index, lần)` ném lỗi theo kịch bản. */
function fakeServer(partSize: number, failPut: (index: number, call: number) => unknown = () => null) {
  const parts = new Map<number, number>()
  let sessions = 0
  let cancelled = 0
  let completed = 0
  const calls = new Map<number, number>()
  const t: ChunkTransport<{ key: string }> = {
    async init({ size }) {
      sessions++
      return { upload_id: `u${sessions}`, part_size: partSize, total_parts: Math.ceil(size / partSize) }
    },
    async status(id) {
      return id === "u1" ? { part_size: partSize, total_parts: 3, received: [...parts.keys()].sort() } : null
    },
    async putPart(_id, index, part, onSent) {
      const n = (calls.get(index) ?? 0) + 1
      calls.set(index, n)
      const err = failPut(index, n)
      if (err) throw err
      onSent(part.size)
      parts.set(index, part.size)
    },
    async complete() {
      completed++
      return { key: "social/u1_1_abc.mp4" }
    },
    async cancel() {
      cancelled++
      parts.clear()
    },
  }
  return { t, parts, calls, stats: () => ({ sessions, cancelled, completed }) }
}

const file = (size: number) => {
  const f = new File([new Uint8Array(size)], "clip.mp4", { type: "video/mp4", lastModified: 5 })
  return f
}
const noWait = async () => undefined

describe("uploadVideoInChunks", () => {
  it("chia đúng phần, báo tiến độ tăng dần tới 100 và xoá nhớ tạm", async () => {
    const s = fakeServer(10)
    const st = memStorage()
    const pct: number[] = []
    const res = await uploadVideoInChunks(file(25), s.t, { storage: st, wait: noWait, onProgress: (p) => pct.push(p) })
    expect(res.key).toBe("social/u1_1_abc.mp4")
    expect([...s.parts.entries()]).toEqual([[0, 10], [1, 10], [2, 5]])
    expect(pct.at(-1)).toBe(100)
    expect(pct).toEqual([...pct].sort((a, b) => a - b))
    expect(st.data.size).toBe(0)
  })

  it("rớt mạng giữa chừng: thử lại phần lỗi, không gửi lại phần đã xong", async () => {
    const s = fakeServer(10, (i, call) => (i === 1 && call <= 2 ? new Error("Network Error") : null))
    await uploadVideoInChunks(file(25), s.t, { storage: memStorage(), wait: noWait })
    expect(s.calls.get(0)).toBe(1)
    expect(s.calls.get(1)).toBe(3)
    expect(s.stats().completed).toBe(1)
  })

  it("hết lượt thử: giữ phiên để tiếp tục; mở lại chỉ gửi phần thiếu", async () => {
    const st = memStorage()
    let netDown = true
    const s = fakeServer(10, (i) => (i === 1 && netDown ? new Error("Network Error") : null))
    await expect(uploadVideoInChunks(file(25), s.t, { storage: st, wait: noWait, retries: 1 })).rejects.toThrow("Network Error")
    expect(st.data.get(resumeKey(file(25)))).toBe("u1")
    expect(s.stats().cancelled).toBe(0)

    // Mạng ổn lại, chọn lại đúng tệp: dùng phiên u1, phần 0 không gửi lại.
    netDown = false
    await uploadVideoInChunks(file(25), s.t, { storage: st, wait: noWait })
    expect(s.stats()).toMatchObject({ sessions: 1, completed: 1 })
    expect(s.calls.get(0)).toBe(1)
    expect([...s.parts.keys()].sort()).toEqual([0, 1, 2])
    expect(st.data.size).toBe(0)
  })

  it("phiên cũ không còn (404): khai phiên mới", async () => {
    const st = memStorage()
    st.setItem(resumeKey(file(25)), "da-het-han")
    const s = fakeServer(10)
    await uploadVideoInChunks(file(25), s.t, { storage: st, wait: noWait })
    expect(s.stats().sessions).toBe(1)
  })

  it("lỗi 4xx không thử lại và dọn phiên; 429 thì thử lại", async () => {
    const s = fakeServer(10, (i) => (i === 0 ? { response: { status: 413 } } : null))
    await expect(uploadVideoInChunks(file(25), s.t, { storage: memStorage(), wait: noWait })).rejects.toBeTruthy()
    expect(s.calls.get(0)).toBe(1)
    expect(s.stats().cancelled).toBe(1)
    expect(isFatalChunkError({ response: { status: 429 } })).toBe(false)
    expect(isFatalChunkError({ response: { status: 408 } })).toBe(false)
    expect(isFatalChunkError({ response: { status: 500 } })).toBe(false)
    expect(isFatalChunkError(new Error("x"))).toBe(false)
  })

  it("huỷ giữa chừng: xoá phiên trên máy chủ, không còn phần rác, quên nhớ tạm", async () => {
    const ac = new AbortController()
    const st = memStorage()
    const s = fakeServer(10, (i, call) => {
      if (i === 1 && call === 1) ac.abort()
      return null
    })
    await expect(uploadVideoInChunks(file(25), s.t, { storage: st, wait: noWait, signal: ac.signal })).rejects.toBeInstanceOf(
      ChunkAborted,
    )
    expect(s.stats()).toMatchObject({ cancelled: 1, completed: 0 })
    expect(s.parts.size).toBe(0)
    expect(st.data.size).toBe(0)
  })
})
