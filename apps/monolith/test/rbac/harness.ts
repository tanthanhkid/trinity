import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { JwtService } from '@nestjs/jwt'
import request from 'supertest'
import { PrismaService } from '@trinity/prisma'
import type { Grants } from '@trinity/rbac'

/**
 * Hạ tầng test E2E quyền — dùng chung cho MỌI cụm BE khi viết ma
 * trận quyền: "user KHÔNG có quyền → 403", "scope own → chỉ thấy
 * bản ghi của mình", "ngoài scope theo id → 404", "phone_full tắt → SĐT bị
 * che".
 *
 * Chạy trên Postgres THẬT qua `RBAC_TEST_DATABASE_URL` (mirror
 * packages/rbac-nest/src/scope.service.spec.ts) — KHÔNG chạy được thì
 * `describe.skip` ở call-site, KHÔNG fake xanh.
 *
 * Guard LUÔN strict — app test boot đủ route nên cũng
 * chạy boot-check route thiếu quyền như môi trường thật.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'rbac-e2e-test-secret'
process.env.INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? 'rbac-e2e-internal-secret'
process.env.SERVICE_SECRET = process.env.SERVICE_SECRET ?? 'rbac-e2e-service-secret'
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER ?? 'local'
process.env.STORAGE_LOCAL_ROOT = process.env.STORAGE_LOCAL_ROOT ?? '/tmp/trinity-rbac-e2e-storage'
process.env.CRM_SERVICE_URL = process.env.CRM_SERVICE_URL ?? 'http://127.0.0.1:4098'
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test'
// Máy dev có thể sẵn DEBUG=prisma:* trong shell — làm log test ngợp câu SQL,
// không liên quan RBAC. Tắt CHỈ trong process test này.
delete process.env.DEBUG

const RBAC_TEST_DATABASE_URL = process.env.RBAC_TEST_DATABASE_URL
if (RBAC_TEST_DATABASE_URL) {
  process.env.DATABASE_URL = RBAC_TEST_DATABASE_URL
}

/** BigInt không serialize được mặc định trong JSON (mirror apps/monolith/src/main.ts). */
;(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this)
}

let migrated = false

/** `migrate deploy` lên `RBAC_TEST_DATABASE_URL` — chạy 1 lần cho cả process test. */
function migrateOnce(): void {
  if (migrated || !RBAC_TEST_DATABASE_URL) return
  const schema = path.resolve(__dirname, '../../../../packages/prisma/prisma/schema.prisma')
  execFileSync('npx', ['--yes', 'prisma@6', 'migrate', 'deploy', `--schema=${schema}`], {
    env: { ...process.env, DATABASE_URL: RBAC_TEST_DATABASE_URL },
    stdio: 'ignore',
  })
  migrated = true
}

export interface BootedApp {
  app: INestApplication
  prisma: PrismaService
  close(): Promise<void>
}

export interface BootOptions {
  /**
   * Bật ValidationPipe toàn cục như môi trường thật (`ServiceAwareValidationPipe` +
   * `requestPathMiddleware`, xem `src/main.ts`) — cần khi test kiểm DTO
   * (400 body sai, ép kiểu query `?limit=`). Mặc định TẮT để các suite cũ
   * giữ nguyên hành vi.
   */
  validation?: boolean
}

export async function bootApp(opts: BootOptions = {}): Promise<BootedApp> {
  if (!RBAC_TEST_DATABASE_URL) {
    throw new Error(
      'RBAC_TEST_DATABASE_URL bắt buộc cho test E2E quyền — xem apps/monolith/test/rbac/harness.ts',
    )
  }
  migrateOnce()

  // Import trễ (sau khi set process.env ở trên) — MonolithModule/RbacModule
  // đọc JWT_SECRET/INTERNAL_SERVICE_SECRET lúc khởi tạo module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MonolithModule } = require('../../src/app.module') as typeof import('../../src/app.module')

  const app = await NestFactory.create<NestExpressApplication>(MonolithModule, {
    logger: false,
    bodyParser: false,
  })
  // Giống main.ts: `captureRawBody` gắn `req.rawBody` (webhook vào kiểm HMAC trên byte thô).
  const captureRawBody = (req: unknown, _res: unknown, buf: Buffer): void => {
    if (buf && buf.length) (req as { rawBody?: Buffer }).rawBody = buf
  }
  app.useBodyParser('json', { limit: '5mb', verify: captureRawBody })
  app.useBodyParser('urlencoded', { extended: true, limit: '5mb' })
  app.setGlobalPrefix('api/v1')
  if (opts.validation) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requestPathMiddleware } = require('../../src/request-path.context') as typeof import('../../src/request-path.context')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ServiceAwareValidationPipe } = require('../../src/service-aware-validation.pipe') as typeof import('../../src/service-aware-validation.pipe')
    app.use(requestPathMiddleware)
    app.useGlobalPipes(new ServiceAwareValidationPipe())
  } else {
    // Giống main.ts: DTO `@Type(() => Number)` (query/param) chỉ ép kiểu khi có
    // ValidationPipe `transform` — thiếu thì service nhận chuỗi, lệch môi trường thật.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  }
  await app.init()

  const prisma = app.get(PrismaService)
  // Một DB mới tinh có `setup_status = chua_dung` (menu "mở ra trống"); các bài test này cần hệ thống đã dựng.
  await prisma.$executeRawUnsafe(
    `INSERT INTO settings (key, value, updated_at) VALUES ('setup_status', 'da_dung', now()) ON CONFLICT (key) DO UPDATE SET value = 'da_dung'`,
  )
  return {
    app,
    prisma,
    close: async () => {
      await app.close()
    },
  }
}

/**
 * Xoá sạch dữ liệu RBAC giữa các test (KHÔNG đụng vai trò hệ thống "Quản
 * trị" — nó phải sống suốt vòng đời DB test, mirror seed.ts). Cụm nào cần
 * xoá thêm bảng nghiệp vụ (contacts/deals/...) tự gọi `$executeRawUnsafe`
 * riêng — hạ tầng này chỉ lo phần RBAC dùng chung.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE role_permissions, user_roles, rbac_audit_log RESTART IDENTITY CASCADE`,
  )
  await prisma.$executeRawUnsafe(`DELETE FROM roles WHERE is_system = false`)
  // Notification rows reference users with RESTRICT, so they must go first (user creation / assignment writes them).
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`,
  )
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE email LIKE '%@rbac-e2e.test'`)
}

let testUserSeq = 0

export interface MakeUserOptions {
  email?: string
  managerId?: number
  grants?: Grants
  admin?: boolean
}

/**
 * Tạo user + 1 vai trò RIÊNG (không dùng chung role với user khác trong cùng
 * test — tránh 1 test sửa grants ảnh hưởng test khác chạy song song) với
 * đúng `grants` truyền vào, mint JWT hợp lệ bằng `JWT_SECRET` của app đang
 * chạy (cùng process → cùng secret).
 */
export async function makeUser(
  prisma: PrismaService,
  opts: MakeUserOptions = {},
): Promise<{ id: number; token: string }> {
  testUserSeq += 1
  const email = opts.email ?? `user-${Date.now()}-${testUserSeq}@rbac-e2e.test`

  const user = await prisma.user.create({
    data: {
      email,
      password_hash: 'x',
      full_name: email,
      status: 'active',
      manager_id: opts.managerId ?? null,
    },
    select: { id: true, email: true },
  })

  const role = await prisma.role.create({
    data: {
      name: `e2e-role-${user.id}-${testUserSeq}`,
      is_system: !!opts.admin,
    },
  })

  if (!opts.admin) {
    for (const [permission, grant] of Object.entries(opts.grants ?? {})) {
      await prisma.rolePermission.create({
        data: {
          role_id: role.id,
          permission,
          scope: grant === true ? null : (grant as string),
        },
      })
    }
  }

  await prisma.userRole.create({ data: { user_id: user.id, role_id: role.id } })

  const jwtService = new JwtService({ secret: process.env.JWT_SECRET })
  const token = jwtService.sign({ sub: user.id, email: user.email })
  return { id: user.id, token }
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'

/** `api(app, token).get('/api/v1/...')` — tự gắn `Authorization: Bearer <token>` khi có. */
export function api(app: INestApplication, token?: string) {
  const server = app.getHttpServer()
  const withAuth = (req: request.Test) => (token ? req.set('Authorization', `Bearer ${token}`) : req)
  const method = (m: Method) => (url: string) => withAuth(request(server)[m](url))
  return {
    get: method('get'),
    post: method('post'),
    patch: method('patch'),
    put: method('put'),
    delete: method('delete'),
  }
}
