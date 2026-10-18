import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Khách thuê của luồng đang chạy (request HTTP, webhook, job nền). Đọc bởi `withTenantRls` để đặt `app.tenant_id`
 * cho mỗi transaction. Không có store / `tenantId` null ⇒ DB không thấy dòng nào của bảng có RLS (fail closed).
 */
export interface TenantStore {
  tenantId: string | null
  /** Đang ở trong `$transaction([...])` dạng mảng mà extension đã chèn `set_config` đầu lô. */
  inBatch?: boolean
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Chạy `fn` trong ngữ cảnh một tenant. Webhook/job nền PHẢI gọi hàm này với tenant tra được (vd theo page_id). */
export function runWithTenant<T>(tenantId: string | null, fn: () => T): T {
  if (tenantId !== null && !UUID_RE.test(tenantId)) throw new Error('tenantId phải là UUID')
  return tenantStorage.run({ tenantId }, () => {
    const r = fn()
    // PrismaPromise LƯỜI: chỉ chạy khi có người gọi `.then`. `runWithTenant(t, () => prisma.x.findMany())` trả nó ra ngoài
    // rồi mới await ⇒ extension chạy NGOÀI ngữ cảnh tenant ⇒ 0 dòng. Ép `.then` ngay bên trong ngữ cảnh.
    return (isThenable(r) ? (async () => await r)() : r) as T
  })
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'
}

export function currentTenantId(): string | null {
  return tenantStorage.getStore()?.tenantId ?? null
}

/** Tenant tạm cho bản một-khách: biến môi trường `TRINITY_DEFAULT_TENANT_ID` (chưa có subdomain / claim JWT). */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001'

export function configuredTenantId(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.TRINITY_DEFAULT_TENANT_ID?.trim()
  return v && UUID_RE.test(v) ? v : DEFAULT_TENANT_ID
}

/** Middleware Express: mọi request chạy trong tenant cấu hình. Bản SaaS thay bằng tenant theo subdomain/claim `tid` đã xác thực. */
export function tenantMiddleware(_req: unknown, _res: unknown, next: () => void): void {
  runWithTenant(configuredTenantId(), next)
}
