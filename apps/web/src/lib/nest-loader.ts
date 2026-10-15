/**
 * Bộ nạp Nest MẶC ĐỊNH (build VPS/pm2, không cờ serverless): KHÔNG `require` tĩnh `@trinity/monolith` — ở VPS package này là
 * symlink workspace, Turbopack sẽ cố đóng gói Nest và vỡ build. Trả `null` ⇒ `nest-bridge` dò đường dẫn như cũ.
 * Build serverless thay file này bằng `nest-loader.serverless.ts` qua `turbopack.resolveAlias` (next.config).
 */
export type NestHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
export type NestModule = { getHandler(): Promise<NestHandler> }

export function loadNestModule(): NestModule | null {
  return null
}
