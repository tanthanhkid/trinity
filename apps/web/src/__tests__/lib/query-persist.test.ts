import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"

const store = new Map<string, unknown>()
vi.mock("@/lib/local-cache", () => ({
  idbGet: async (k: string) => store.get(k),
  idbSet: async (k: string, v: unknown) => void store.set(k, v),
  idbDelete: async (k: string) => void store.delete(k),
  onWipe: () => () => {},
}))
vi.mock("@/lib/token-storage", () => ({ getAccessToken: () => "tok" }))

import { PERSIST_BUSTER, PERSIST_MAX_AGE_MS, persistKey, restoreQueries, shouldPersistQuery, startPersisting } from "@/lib/query-persist"

const q = (queryKey: unknown[], status = "success", ...rest: [unknown?]) =>
  ({ queryKey, state: { status, data: rest.length ? rest[0] : { a: 1 } } }) as never

beforeEach(() => store.clear())

describe("query-persist", () => {
  it("khoá cache có người dùng + công ty", () => {
    expect(persistKey({ userId: 7, companyId: 3 })).toBe("rq:3:7")
    expect(persistKey({ userId: 7, companyId: null })).toBe("rq:0:7")
    expect(persistKey({ userId: 7, companyId: 3 })).not.toBe(persistKey({ userId: 8, companyId: 3 }))
  })

  it("chỉ lưu query thành công, bỏ khoá nhạy cảm", () => {
    expect(shouldPersistQuery(q(["contacts", "page", 1]))).toBe(true)
    expect(shouldPersistQuery(q(["contacts"], "error"))).toBe(false)
    expect(shouldPersistQuery(q(["contacts"], "success", undefined))).toBe(false)
    expect(shouldPersistQuery(q(["settings", "api-keys"]))).toBe(false)
    expect(shouldPersistQuery(q(["integrations", "webhooks", "endpoints"]))).toBe(false)
    expect(shouldPersistQuery(q(["oauth", "clients"]))).toBe(false)
    expect(shouldPersistQuery(q(["auth", "token"]))).toBe(false)
  })

  it("ghi rồi nạp lại đúng người; người khác không thấy", async () => {
    vi.useFakeTimers()
    const a = new QueryClient()
    a.setQueryData(["contacts", "recent"], [{ id: 1 }])
    a.setQueryData(["settings", "api-keys"], ["bí mật"])
    const stop = startPersisting(a, { userId: 1, companyId: 1 })
    a.getQueryCache().notify({ type: "updated", query: a.getQueryCache().getAll()[0], action: { type: "success", data: 1, dataUpdatedAt: 1, manual: true } } as never)
    await vi.advanceTimersByTimeAsync(2000)
    stop()
    vi.useRealTimers()
    const saved = store.get("rq:1:1") as { state: { queries: unknown[] } }
    expect(JSON.stringify(saved)).not.toContain("bí mật")

    const b = new QueryClient()
    expect(await restoreQueries(b, { userId: 1, companyId: 1 })).toBe(true)
    expect(b.getQueryData(["contacts", "recent"])).toEqual([{ id: 1 }])
    expect(b.getQueryData(["settings", "api-keys"])).toBeUndefined()
    const other = new QueryClient()
    expect(await restoreQueries(other, { userId: 2, companyId: 1 })).toBe(false)
    expect(other.getQueryData(["contacts", "recent"])).toBeUndefined()
  })

  it("không hydrate khi effect đã dọn (đăng xuất/đổi người giữa chừng)", async () => {
    store.set("rq:1:1", { buster: PERSIST_BUSTER, savedAt: Date.now(), state: { mutations: [], queries: [{ queryKey: ["x"], queryHash: '["x"]', state: { data: 1, dataUpdateCount: 1, dataUpdatedAt: Date.now(), error: null, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, status: "success", fetchStatus: "idle" } }] } })
    const c = new QueryClient()
    expect(await restoreQueries(c, { userId: 1, companyId: 1 }, () => true)).toBe(false)
    expect(c.getQueryData(["x"])).toBeUndefined()
    expect(await restoreQueries(c, { userId: 1, companyId: 1 })).toBe(true)
    expect(c.getQueryData(["x"])).toBe(1)
  })

  it("bỏ cache hết hạn hoặc khác buster", async () => {
    const mk = (savedAt: number, buster: string) => ({ buster, savedAt, state: { mutations: [], queries: [] } })
    store.set("rq:1:1", mk(Date.now() - PERSIST_MAX_AGE_MS - 1000, PERSIST_BUSTER))
    expect(await restoreQueries(new QueryClient(), { userId: 1, companyId: 1 })).toBe(false)
    expect(store.has("rq:1:1")).toBe(false)
    store.set("rq:1:1", mk(Date.now(), "cu"))
    expect(await restoreQueries(new QueryClient(), { userId: 1, companyId: 1 })).toBe(false)
  })
})
