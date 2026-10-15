/**
 * Bộ nạp Nest cho build SERVERLESS — chọn qua `turbopack.resolveAlias` khi `TRINITY_RUNTIME=serverless`.
 * `require` TĨNH ⇒ Next coi `@trinity/monolith` là external (`serverExternalPackages`, thư mục thật do
 * `scripts/vercel/prepare-nest-package.sh` đặt vào node_modules) và VẾT đủ file + phụ thuộc vào hàm Vercel.
 */
import type { NestModule } from "./nest-loader"

export type { NestHandler, NestModule } from "./nest-loader"

export function loadNestModule(): NestModule | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@trinity/monolith/serverless") as NestModule
}
