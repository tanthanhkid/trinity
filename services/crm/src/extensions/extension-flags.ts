import { isServerless } from '@trinity/rbac-nest';

/**
 * chương trình con chỉ bật khi `EXTENSIONS_ENABLED=true` VÀ không chạy serverless
 * (môi trường serverless không giữ được tiến trình dài ⇒ luôn tắt ở đó). Tắt = không timer, không tiến trình Deno, tool MCP bị ẩn, API trả 404.
 */
export function extensionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXTENSIONS_ENABLED?.trim().toLowerCase() === 'true' && !isServerless();
}

/** Lỗi liên tiếp thì tự tắt chương trình con (mặc định 3). */
export function maxConsecutiveFailures(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EXTENSIONS_MAX_FAILURES);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 3;
}

export const denoBin = (env: NodeJS.ProcessEnv = process.env): string => env.EXTENSIONS_DENO_BIN?.trim() || 'deno';
