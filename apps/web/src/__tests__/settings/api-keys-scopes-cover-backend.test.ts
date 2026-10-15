/**
 * The API-key UI must cover every scope the backend declares.
 * The two lists live in different services and cannot be imported across
 * (separate `rootDir`), so the backend source is read as text.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const REPO = join(__dirname, "../../../../..")
const AUTH_DTO = join(REPO, "services/auth/src/api-keys/dto/create-api-key.dto.ts")
const SETTINGS_UI = join(
  REPO,
  "apps/web/src/app/(dashboard)/settings/_components/settings-api-keys.tsx",
)

/** Bỏ comment TRƯỚC khi soi — docblock hợp lệ có nhắc tên phạm vi (bẫy repo). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

/** Đọc mảng `API_KEY_SCOPES = [...] as const` của Auth. */
function backendScopes(): string[] {
  const src = stripComments(readFileSync(AUTH_DTO, "utf8"))
  const block = src.match(/API_KEY_SCOPES\s*=\s*\[([\s\S]*?)\]\s*as const/)
  expect(block, "không tìm thấy khai báo API_KEY_SCOPES ở Auth").toBeTruthy()
  const scopes = [...(block as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map(
    (m) => m[1],
  )
  expect(scopes.length).toBeGreaterThan(0)
  return scopes
}

describe("UI cấp khoá API (v2) phủ đủ phạm vi BE khai", () => {
  it("BE đang khai đúng 4 phạm vi", () => {
    expect(backendScopes().sort()).toEqual(["auth:login", "contacts:create", "deals:create", "tasks:create"])
  })

  it("mỗi phạm vi BE khai đều có 1 mục chọn trong màn v2", () => {
    const ui = stripComments(readFileSync(SETTINGS_UI, "utf8"))
    const block = ui.match(/const SCOPES = \[([\s\S]*?)\] as const/)
    expect(block, "không tìm thấy mảng SCOPES trong màn v2").toBeTruthy()
    const declared = [
      ...(block as RegExpMatchArray)[1].matchAll(/value:\s*'([^']+)'/g),
    ].map((m) => m[1])
    for (const scope of backendScopes()) {
      expect(declared, `thiếu phạm vi "${scope}" trong dropdown v2`).toContain(
        scope,
      )
    }
  })

  /**
   * `z.enum` phải sinh TỪ `SCOPES` — hardcode lại danh sách thứ 2 trong cùng
   * file là chỗ để quên tiếp: tick được ô nhưng submit bị zod chặn, và thông
   * báo lỗi không nói gì về nguyên nhân.
   */
  it("zod đọc từ chính mảng SCOPES, không hardcode danh sách thứ 2", () => {
    const ui = stripComments(readFileSync(SETTINGS_UI, "utf8"))
    expect(ui).toMatch(/z\.enum\(SCOPE_VALUES\)/)
    expect(ui).not.toMatch(/z\.enum\(\s*\[\s*'auth:login'/)
  })

})
