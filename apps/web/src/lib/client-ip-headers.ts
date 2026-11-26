/**
 * Header IP do client gửi — xoá trước khi chuyển request sang API. API xác định IP khách theo `TRUSTED_PROXY` và chữ ký
 * `x-trinity-client-ip` (docs/deployment.md, mục "Client IP"); nếu web chép nguyên các header này thì client tự khai
 * được IP (vd `X-Forwarded-For: <IP văn phòng>` qua Caddy → Next → API với `cidr:127.0.0.1/32`).
 * Web chưa tự xác định và ký IP (G16b), nên tạm thời API thấy "không tin được" (cho qua + cảnh báo quản trị).
 */
const CLIENT_IP_HEADERS = new Set(['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'true-client-ip'])

export function isClientIpHeader(name: string): boolean {
  const k = name.toLowerCase()
  return CLIENT_IP_HEADERS.has(k) || k.startsWith('x-trinity-')
}

/** `TRUSTED_PROXY=cloudflare-tunnel` tin `cf-connecting-ip` của mọi peer ⇒ web phải nghe loopback (`HOSTNAME`). Trả lỗi hoặc null. */
export function webTunnelListenProblem(env: Record<string, string | undefined>): string | null {
  if ((env.TRUSTED_PROXY ?? '').trim() !== 'cloudflare-tunnel') return null
  const host = (env.HOSTNAME ?? '').trim().replace(/^\[|\]$/g, '')
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return null
  return (
    `TRUSTED_PROXY=cloudflare-tunnel nhưng web nghe HOSTNAME=${host || '(trống = mọi giao diện)'}, không phải loopback: ` +
    'ai nối thẳng cổng web sẽ tự khai được IP. Đặt HOSTNAME=127.0.0.1 hoặc chọn giá trị TRUSTED_PROXY khác (docs/deployment.md, mục "Client IP").'
  )
}
