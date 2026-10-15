import { describe, expect, it } from "vitest"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 Bất biến: package `@trinity/*` nào được code CHẠY LÚC RUNTIME import thì
 * `main` PHẢI trỏ file JS đã biên dịch, KHÔNG trỏ `src/*.ts`.
 *
 * ## Vì sao có test này
 *
 * Một package có `main: "./src/index.ts"`, không có script
 * `build`, không có `dist` sẽ gây ra:
 *
 * - **`tsc` vẫn compile XANH** — nó đọc được TS source, resolve type bình thường.
 *   Nên build local và build trên máy đều không hé một lời.
 * - **Runtime thì CHẾT.** Node 24 tự strip type cho `.ts`, nhưng nạp file đó như
 *   **ESM** ⇒ `export { envCompat } from './env-compat'` (không đuôi) không
 *   resolve được: `ERR_MODULE_NOT_FOUND: .../src/env-compat`. Thêm
 *   `"type": "commonjs"` cũng không cứu — CJS không parse được `export`.
 *
 * Triệu chứng: monolith crash-loop, health trả **000** trong khi tiến trình vẫn
 * ghi `online` và build báo **exit 0**. Cách đúng: dựng `dist` rồi trỏ `main`
 * vào đó, như `@trinity/logger` (`main: "./dist/index.js"`, `build: "tsc"`).
 *
 * Test đọc package.json THẬT nên thêm package `@trinity/*` mới mà quên build là
 * ĐỎ ngay, thay vì phát hiện lúc service không lên nữa.
 */

const PKG_DIR = join(__dirname, "../../../../../packages")

/** Package chỉ dùng cho type/tooling, không bị import ở đường chạy runtime. */
const TYPE_ONLY_ALLOWLIST = new Set(["@trinity/shared-types"])

interface PkgJson {
  name?: string
  main?: string
  types?: string
  scripts?: Record<string, string>
}

function workspacePackages(): Array<{ dir: string; pkg: PkgJson }> {
  return readdirSync(PKG_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PKG_DIR, e.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PkgJson }))
}

const pkgs = workspacePackages()

describe("packages/@trinity/* — phải nạp được lúc runtime", () => {
  it("đọc được danh sách package", () => {
    expect(pkgs.length).toBeGreaterThan(2)
  })

  for (const { dir, pkg } of pkgs) {
    const name = pkg.name ?? dir
    if (TYPE_ONLY_ALLOWLIST.has(name)) continue

    it(`${name}: main KHÔNG trỏ src/*.ts`, () => {
      expect(pkg.main, `${name} thiếu "main"`).toBeTruthy()
      expect(pkg.main, `${name}.main = ${pkg.main}`).not.toMatch(/\.tsx?$/)
    })

    it(`${name}: có script build (nếu không thì không ai sinh ra dist)`, () => {
      expect(pkg.scripts?.build, `${name} thiếu scripts.build`).toBeTruthy()
    })

    it(`${name}: có tsconfig.json để build`, () => {
      expect(existsSync(join(dir, "tsconfig.json")), `${name} thiếu tsconfig.json`).toBe(true)
    })
  }
})
