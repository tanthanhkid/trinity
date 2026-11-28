import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assetsOfHtml, MAIN_PAGES, writeServiceWorker } from "../../../scripts/make-sw.mjs"

describe("make-sw", () => {
  it("lấy JS/CSS /_next/static từ HTML, bỏ query và ngoài /_next/static", () => {
    const html =
      '<link rel="stylesheet" href="/_next/static/chunks/a.css"/><script src="/_next/static/chunks/b.js" async></script>' +
      '<script src="https://cdn.x/c.js"></script><link href="/_next/static/media/f.woff2"/>'
    expect([...assetsOfHtml(html)].sort()).toEqual(["/_next/static/chunks/a.css", "/_next/static/chunks/b.js"])
  })
  it("các màn chính có đủ 7 màn + login", () => {
    for (const p of ["/dashboard", "/contacts", "/inbox", "/kanban", "/reports", "/products", "/connections", "/login"]) {
      expect(MAIN_PAGES).toContain(p)
    }
  })
})

describe("writeServiceWorker", () => {
  it("điền đủ mã build/precache/trang, không sót chỗ giữ chỗ, script hợp lệ", () => {
    const out = mkdtempSync(join(tmpdir(), "sw-out-"))
    // Thư mục "AAA" (đứng đầu theo thứ tự) không phải build id; chỉ thư mục có _buildManifest.js mới đúng.
    mkdirSync(join(out, "_next", "static", "AAA"), { recursive: true })
    mkdirSync(join(out, "_next", "static", "BUILDX"), { recursive: true })
    writeFileSync(join(out, "_next", "static", "BUILDX", "_buildManifest.js"), "")
    writeFileSync(join(out, "dashboard.html"), '<script src="/_next/static/chunks/a.js"></script>')
    writeFileSync(join(out, "login.html"), '<script src="/_next/static/chunks/b.js"></script>')
    const r = writeServiceWorker(out)
    expect(r).toEqual({ id: "BUILDX", precache: 2, pages: 2 })
    const js = readFileSync(join(out, "sw.js"), "utf8")
    expect(js).not.toMatch(/__PRECACHE__|__PAGES__|'__BUILD_ID__'/)
    expect(js).toContain('const BUILD_ID = "BUILDX"')
    expect(js).toContain('"/_next/static/chunks/a.js"')
    expect(() => new Function(js)).not.toThrow()
  })
})
