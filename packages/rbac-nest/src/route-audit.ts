import type { INestApplication } from '@nestjs/common'
import { PATH_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import type { Permission } from '@trinity/rbac'
import { RBAC_META, AccessMeta } from './decorators'

const EXPORT_PATH_RE = /(export|excel|xlsx|csv|download)/i

export interface RouteAuditResult {
  /** Route KHÔNG có metadata `@Can`/`@AuthOnly`/`@Public`/`@Internal` — deny-by-default vi phạm. */
  missing: string[]
  /** Route path trông như xuất file nhưng quyền gắn không phải `*.export` (và không phải ngoại lệ public/internal). */
  exportWithoutPerm: string[]
}

function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
  return `/${joined}`
}

/**
 * Boot-check quét MỌI route qua `DiscoveryService` — deny-by-default.
 * Gọi từ `main.ts` sau `app.init()`; kết quả không rỗng →
 * dừng khởi động (process.exit(1)) — luôn chạy, không có công tắc tắt.
 */
export function auditRoutes(app: INestApplication): RouteAuditResult {
  const discoveryService = app.get(DiscoveryService)
  const metadataScanner = app.get(MetadataScanner)
  const reflector = app.get(Reflector)

  const missing: string[] = []
  const exportWithoutPerm: string[] = []

  for (const wrapper of discoveryService.getControllers()) {
    const { instance, metatype } = wrapper
    if (!instance || !metatype) continue
    const prototype = Object.getPrototypeOf(instance)
    const classPath: string | undefined = Reflect.getMetadata(PATH_METADATA, metatype)

    for (const methodName of metadataScanner.getAllMethodNames(prototype)) {
      const methodRef = prototype[methodName]
      const methodPath: string | undefined = Reflect.getMetadata(PATH_METADATA, methodRef)
      // Chỉ những method thật sự khai `@Get/@Post/...` mới có PATH_METADATA riêng.
      if (methodPath === undefined) continue

      const path = joinPath(classPath, methodPath)
      const meta = reflector.getAllAndOverride<AccessMeta | undefined>(RBAC_META, [
        methodRef,
        metatype,
      ])

      if (!meta) {
        missing.push(path)
        continue
      }

      if (EXPORT_PATH_RE.test(path)) {
        const isException = meta.kind === 'internal' || meta.kind === 'public'
        const hasExportPerm =
          meta.kind === 'can' && meta.permissions.some((p: Permission) => p.endsWith('.export'))
        if (!isException && !hasExportPerm) {
          exportWithoutPerm.push(path)
        }
      }
    }
  }

  return { missing, exportWithoutPerm }
}
