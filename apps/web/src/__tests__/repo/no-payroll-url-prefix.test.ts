/**
 * `GET /api/v1/payroll/payslips` → 404. Controller
 * payroll là `/payslips`, `/salary-rules`, `/reports`… (monolith chỉ có prefix
 * `api/v1`, KHÔNG có `payroll/`). FE không được
 * gọi apiClient với tiền tố `/payroll/`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      if (n !== "__tests__" && n !== "node_modules") walk(p, out)
    } else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}

describe("FE không gọi API với tiền tố /payroll/", () => {
  it("không có apiClient.* / fetch nào trỏ `/payroll/<resource>`", () => {
    const re = /(?:apiClient\.\w+(?:<[^>]*>)?\(\s*|fetch\(\s*)["'`]\/payroll\//
    const bad = walk(join(process.cwd(), "src")).filter((f) => re.test(readFileSync(f, "utf8")))
    expect(bad).toEqual([])
  })

  it("payroll-payslips / reports dùng đúng đường dẫn BE", () => {
    const base = join(process.cwd(), "src/app/(dashboard)/payroll/_components")
    expect(readFileSync(join(base, "payroll-payslips.tsx"), "utf8")).toContain('"/payslips", { params: { month } }')
    expect(readFileSync(join(base, "payroll-reports.tsx"), "utf8")).toContain('"/reports/summary"')
  })
})
