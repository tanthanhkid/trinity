import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 Bất biến: code trong `services/**` KHÔNG được hardcode cổng 4001–4006.
 * Monolith chỉ nghe 4000 — gọi tới 4001–4006 là gọi vào hư không, và vì các
 * chỗ gọi đó thường là fire-and-forget/retry-rồi-nuốt-lỗi nên build, test,
 * health đều xanh trong khi thông báo realtime và các tác vụ nền hỏng âm thầm.
 *
 * Giữa các module CÙNG process: dùng DI/port (`apps/monolith/src/internal-ports`),
 * KHÔNG dùng HTTP loopback. Chỉ dòng CODE bị quét — comment được phép nhắc các cổng này.
 */

const SERVICES_DIR = join(__dirname, "../../../../../services")
const DEAD_PORT = /(localhost|127\.0\.0\.1):400[1-6]\b/
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) out.push(full)
  }
}

describe("services/** không hardcode cổng nội bộ chết 4001–4006", () => {
  it("không có dòng code nào trỏ localhost:4001..4006", () => {
    const files: string[] = []
    walk(SERVICES_DIR, files)
    expect(files.length).toBeGreaterThan(100)

    const offenders: string[] = []
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!COMMENT_LINE.test(line) && DEAD_PORT.test(line)) {
            offenders.push(`${file.slice(SERVICES_DIR.length + 1)}:${i + 1}  ${line.trim()}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })

  it("không còn biến *_SERVICE_URL / NOTIFICATION_*_URL cho gọi nội bộ giữa module", () => {
    const files: string[] = []
    walk(SERVICES_DIR, files)
    const offenders: string[] = []
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (
            !COMMENT_LINE.test(line) &&
            /\b(CRM_SERVICE_URL|NOTIFICATION_SERVICE_URL|NOTIFICATION_WS_EMIT_URL|NOTIFICATION_URL|PAYROLL_URL)\b/.test(line)
          ) {
            offenders.push(`${file.slice(SERVICES_DIR.length + 1)}:${i + 1}  ${line.trim()}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})
