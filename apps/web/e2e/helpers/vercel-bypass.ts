/**
 * Chạy e2e trên bản Vercel có "Vercel Authentication" (URL deployment riêng, preview): đặt
 * `VERCEL_AUTOMATION_BYPASS_SECRET` = khoá "Protection Bypass for Automation" của project. Không đặt ⇒ không thêm
 * header nào (máy chủ tự quản / domain riêng chạy y như cũ). Header `x-vercel-set-bypass-cookie` để trình duyệt nhận cookie
 * bypass cho cả request con (JS chunk, ảnh) không mang header.
 */
export function bypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  return secret ? { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' } : {}
}
