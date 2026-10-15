/**
 * bất biến 0B #1: trang `/oauth/authorize` nằm NGOÀI `app/(dashboard)` (như `/login`), KHÔNG tạo route group anh em
 * mang cây provider dashboard, và KHÔNG import provider của dashboard. Middleware gửi người chưa đăng nhập qua /login rồi quay lại.
 */
import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { NextRequest } from "next/server"
import { proxy as middleware } from "../../proxy"

const APP = join(process.cwd(), "src/app")
const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8")
/** Bỏ comment để không dương tính giả khi chú thích nhắc tên provider/hook. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("/oauth/authorize", () => {
  it("nằm ngoài (dashboard) và không có route group mới ở gốc app/", () => {
    expect(existsSync(join(APP, "oauth/authorize/page.tsx"))).toBe(true)
    expect(existsSync(join(APP, "(dashboard)/oauth"))).toBe(false)
    const groups = readdirSync(APP).filter((n) => /^\(.+\)$/.test(n))
    expect(groups).toEqual(["(dashboard)"])
  })

  it("không import provider của dashboard", () => {
    const files = ["app/oauth/authorize/page.tsx", "app/oauth/authorize/_components/authorize-content.tsx", "app/oauth/authorize/_components/consent-client.tsx"]
    for (const f of files) expect(code(f)).not.toMatch(/SidebarProvider|NotificationSocket/)
  })

  it("useSearchParams chỉ ở component con và page bọc Suspense", () => {
    expect(code("app/oauth/authorize/page.tsx")).toMatch(/<Suspense/)
    expect(code("app/oauth/authorize/page.tsx")).not.toMatch(/useSearchParams\(/)
    expect(code("app/oauth/authorize/_components/authorize-content.tsx")).toMatch(/useSearchParams\(/)
  })

  it("chưa đăng nhập ⇒ /login?next=<đường dẫn đồng ý>; path khác ⇒ /login trần như cũ", () => {
    const r = middleware(new NextRequest("https://crm.example.com/oauth/authorize?client_id=c&state=s%26x"))
    expect(r.status).toBe(307)
    const loc = new URL(r.headers.get("location") as string)
    expect(loc.pathname).toBe("/login")
    expect(loc.searchParams.get("next")).toBe("/oauth/authorize?client_id=c&state=s%26x")
    const other = middleware(new NextRequest("https://crm.example.com/contacts"))
    expect(new URL(other.headers.get("location") as string).search).toBe("")
  })

  it("có phiên ⇒ đi tiếp (không redirect)", () => {
    const req = new NextRequest("https://crm.example.com/oauth/authorize?client_id=c", { headers: { cookie: "has_session=1" } })
    expect(middleware(req).headers.get("location")).toBeNull()
  })

  it("trang đăng nhập dùng safeNextPath khi quay lại", () => {
    expect(read("app/login/page.tsx")).toContain("safeNextPath")
  })
})
