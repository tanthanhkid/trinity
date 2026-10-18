import { Prisma, PrismaClient } from '@prisma/client'
import { tenantStorage } from './tenant-context'

/**
 * Prisma client extension: mỗi truy vấn chạy trong một transaction có `set_config('app.tenant_id', <tenant>, true)`
 * (= `SET LOCAL`, hết transaction là mất — kết nối trả về pool không mang tenant cũ sang request khác).
 *
 * - Lệnh lẻ (model + `$queryRaw`/`$executeRaw`): bọc thành lô `[set_config, lệnh]`.
 * - `$transaction(async (tx) => …)`: đặt tenant một lần đầu transaction; `tx` là client gốc nên lệnh trong đó không bọc lại.
 * - `$transaction([…])`: chèn `set_config` vào đầu lô.
 * - Không có tenant trong ngữ cảnh ⇒ chạy nguyên lệnh, KHÔNG đặt gì ⇒ RLS trả 0 dòng / chặn ghi.
 *
 * Bảo vệ thật nằm ở DB (policy RLS); extension chỉ cấp tenant. Quên bọc ⇒ lỗi theo hướng an toàn, không lộ dữ liệu.
 */
const setTenant = (db: Pick<PrismaClient, '$executeRaw'>, tenantId: string) =>
  db.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`

export function withTenantRls<C extends PrismaClient>(base: C) {
  return base.$extends({
    name: 'tenant-rls',
    query: {
      async $allOperations({ args, query }) {
        const store = tenantStorage.getStore()
        if (!store?.tenantId || store.inBatch) return query(args)
        const [, result] = await base.$transaction([setTenant(base, store.tenantId), query(args) as Prisma.PrismaPromise<unknown>])
        return result
      },
    },
    client: {
      $transaction(arg: unknown, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) {
        const tenantId = tenantStorage.getStore()?.tenantId ?? null
        if (typeof arg === 'function') {
          const fn = arg as (tx: Prisma.TransactionClient) => Promise<unknown>
          return base.$transaction(async (tx) => {
            if (tenantId) await setTenant(tx, tenantId)
            return fn(tx)
          }, options)
        }
        const items = arg as Prisma.PrismaPromise<unknown>[]
        return tenantStorage.run({ tenantId, inBatch: true }, () =>
          base.$transaction(tenantId ? [setTenant(base, tenantId), ...items] : items, options).then((r) => (tenantId ? r.slice(1) : r)),
        )
      },
    },
  })
}

export type TenantRlsClient = ReturnType<typeof withTenantRls>
