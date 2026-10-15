/**
 * Cờ chế độ chạy: `TRINITY_RUNTIME=serverless` = chạy như hàm Vercel
 * (không listen, không timer, không đĩa ghi cố định). KHÔNG đặt cờ =
 * chạy như server thường.
 */
export function isServerlessRuntime(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.TRINITY_RUNTIME?.trim().toLowerCase()
  if (flag) return flag === 'serverless'
  // On Vercel the flag is implied, so a fresh deploy needs no extra env var.
  return env.VERCEL === '1'
}

/** Số kết nối Prisma TỐI THIỂU mỗi instance: code có transaction tương tác (`$transaction(async tx => …)`) vẫn gọi
 *  `this.prisma` ngoài `tx` ⇒ cần ≥2 kết nối, `connection_limit=1` làm treo 10s rồi lỗi "Transaction already closed"
 *  3 chừa dư; PgBouncer/pooler gom lại nên không tốn kết nối thật. */
export const MIN_SERVERLESS_CONNECTION_LIMIT = 3

/**
 * Chuẩn hoá chuỗi kết nối cho hàm serverless: Neon pooled (host chứa `-pooler`, PgBouncer transaction mode) cần
 * `pgbouncer=true` (Prisma tắt prepared statement); `connection_limit` đặt sàn `MIN_SERVERLESS_CONNECTION_LIMIT`
 * (thiếu → đặt; nhỏ hơn sàn, vd `=1` theo tài liệu cũ → nâng lên sàn; lớn hơn → giữ). Chỉ sửa chuỗi dùng trong process
 * — không sửa env đã cấu hình.
 */
export function withPooledParams(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.hostname.includes('-pooler') && !parsed.searchParams.has('pgbouncer')) {
    parsed.searchParams.set('pgbouncer', 'true')
  }
  const current = Number(parsed.searchParams.get('connection_limit'))
  if (!(current >= MIN_SERVERLESS_CONNECTION_LIMIT)) {
    parsed.searchParams.set('connection_limit', String(MIN_SERVERLESS_CONNECTION_LIMIT))
  }
  return parsed.toString()
}
