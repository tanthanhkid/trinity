/** Cấu hình do bộ chạy (`CONTRACT_BASE_URL` chứ không phải `BASE_URL`: vitest/Vite tự đặt `BASE_URL`='/')  (`run.ts`) đặt qua env; test chỉ đọc ở đây. */
function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Thiếu biến môi trường ${name} (chạy qua \`pnpm --filter @trinity/contract-tests test\`)`)
  return v
}

export const config = {
  baseUrl: need('CONTRACT_BASE_URL').replace(/\/+$/, ''),
  databaseUrl: need('CONTRACT_DATABASE_URL'),
  serviceSecret: need('SERVICE_SECRET'),
  adminEmail: need('CONTRACT_ADMIN_EMAIL'),
  adminPassword: need('CONTRACT_ADMIN_PASSWORD'),
  profile: process.env.CONTRACT_PROFILE ?? 'default',
  /** `record`: ghi kết quả đã chuẩn hoá (chạy Node); `compare`: so với bản đã ghi (chạy Rust). */
  mode: (process.env.CONTRACT_MODE ?? 'record') as 'record' | 'compare',
  outDir: need('CONTRACT_OUT_DIR'),
  /** Ghi đè golden commit ở `server/contracts/golden/` (chỉ để xem diff khi review). */
  updateGolden: process.env.UPDATE_GOLDEN === '1',
}
