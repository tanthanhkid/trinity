import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * 🔴 Bất biến RBAC quyền + phạm vi: code web (`apps/web/src`, trừ
 * `__tests__/`) KHÔNG được gate/hiển thị theo mã vai trò cứng.
 * Vai trò do admin tự tạo/đặt tên; mọi gate đi qua `usePermissions()` /
 * `<Can>` (`@/lib/rbac`). Một chỗ còn so `role === 'sales'` KHÔNG báo lỗi nào —
 * `useAuth().role` luôn `null` nên gate chết IM LẶNG.
 *
 * Quét CODE (đã bỏ comment). Cấm:
 *  - mã vai trò dạng chuỗi ('sales', "accountant"…)
 *  - `*_ROLES` (hằng tập vai trò), `realRole`, `deniedRoles`
 *
 * Ngoại lệ hợp lệ: ghi vào ALLOWLIST theo `file:dòng` kèm lý do (giá trị dữ liệu
 * nghiệp vụ không phải vai trò). Hiện KHÔNG có ngoại lệ nào.
 */

const SRC = join(__dirname, "../..")
const ROLE_CODES = ["super_admin", "sales", "accountant", "marketing"]

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "mã vai trò dạng chuỗi", re: new RegExp(`["'\`](${ROLE_CODES.join("|")})["'\`]`) },
  { name: "hằng *_ROLES", re: /\b[A-Z][A-Z0-9_]*_ROLES\b/ },
  { name: "realRole", re: /\brealRole\b/ },
  { name: "deniedRoles", re: /\bdeniedRoles\b/ },
  { name: "kiểu UserRole", re: /\bUserRole\b/ },
  { name: "đọc role từ useAuth", re: /\{[^}]*\brole\b[^}]*\}\s*=\s*useAuth\(|useAuth\(\)\.role\b/ },
  { name: "so user.role với literal", re: /\b(?:user|me|u)\??\.role\s*[!=]==?\s*["'`]/ },
]

/** `file:dòng` (tương đối `apps/web/src`) → lý do. */
const ALLOWLIST: Record<string, string> = {}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === ".next") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
}

/** Thay comment bằng khoảng trắng, GIỮ nguyên số dòng. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ")
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + blank(m.slice(p1.length)))
}

describe("web không còn gate/nhãn theo mã vai trò cứng", () => {
  it("0 lần xuất hiện mã vai trò / *_ROLES / realRole / deniedRoles trong code", () => {
    const files: string[] = []
    walk(SRC, files)
    expect(files.length).toBeGreaterThan(200)

    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          for (const { name, re } of FORBIDDEN) {
            if (re.test(line) && !(`${rel}:${i + 1}` in ALLOWLIST)) {
              offenders.push(`${rel}:${i + 1}  [${name}]  ${line.trim().slice(0, 120)}`)
            }
          }
        })
    }
    expect(offenders).toEqual([])
  })

  it("allowlist không chứa mục thừa (dòng không còn vi phạm)", () => {
    const stale = Object.keys(ALLOWLIST).filter((key) => {
      const [rel, lineNo] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))]
      const line = stripComments(readFileSync(join(SRC, rel), "utf8")).split("\n")[lineNo - 1] ?? ""
      return !FORBIDDEN.some(({ re }) => re.test(line))
    })
    expect(stale).toEqual([])
  })

  it("các file/module vai trò cũ đã xoá", () => {
    for (const gone of [
      "lib/role-inheritance.ts",
      "lib/role-labels.ts",
      "lib/permissions.ts",
      "lib/notification-visibility.ts",
      "hooks/use-real-role.ts",
    ]) {
      expect(() => statSync(join(SRC, gone))).toThrow()
    }
  })
})
