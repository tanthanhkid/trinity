import type { NestExpressApplication } from '@nestjs/platform-express'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import * as path from 'node:path'

import { requestPathMiddleware } from './request-path.context'
import { ServiceAwareValidationPipe } from './service-aware-validation.pipe'
import { LoggingInterceptor, ElkExceptionFilter } from '@trinity/logger'
import { auditRoutes } from '@trinity/rbac-nest'
import { tenantMiddleware } from '@trinity/prisma'

// BigInt không serialize được mặc định trong JSON (cùng cách làm ở entrypoint của các service)
// eslint-disable-next-line @typescript-eslint/no-redeclare
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this)
}

/**
 * CORS: danh sách origin được phép lấy từ `CORS_ORIGIN` (phân tách bằng dấu phẩy;
 * mỗi mục là một origin đầy đủ, hoặc `*.example.com` để cho mọi subdomain). Mặc
 * định `http://localhost:3000`. `localhost` bất kỳ cổng luôn được phép (dev).
 */
const LOCALHOST_ORIGIN_RE = /^https?:\/\/localhost(:\d+)?$/

export function isOriginAllowed(origin: string, configured: string): boolean {
  if (process.env.NODE_ENV !== 'production' && LOCALHOST_ORIGIN_RE.test(origin)) return true
  return configured
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === origin) return true
      const m = /^(https?:\/\/)?\*\.(.+)$/.exec(entry)
      if (!m) return false
      const host = m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`^https?:\\/\\/[a-z0-9-]+\\.${host}$`, 'i').test(origin)
    })
}

export function corsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) return cb(null, true) // same-origin / curl
  const configured = process.env.CORS_ORIGIN || 'http://localhost:3000'
  cb(null, isOriginAllowed(origin, configured))
}

/** `bodyParser: false` + `useBodyParser` — dùng chung 2 chế độ (rawBody cho HMAC webhook). */
export const NEST_CREATE_OPTIONS = { bodyParser: false } as const

export interface ConfigureAppOptions {
  /** Chạy sau body parser, trước CORS/prefix (cách tắt process: shutdown hooks hay hàm tự lo). */
  afterBodyParser?: () => void
  /** Phục vụ `/uploads` từ đĩa cục bộ (chế độ server thường). Serverless: false — file đi qua `@trinity/storage`. */
  serveUploads: boolean
  /** Swagger `/docs`. Serverless mặc định tắt (tốn cold start). */
  swagger: boolean
}

/**
 * Cấu hình Nest dùng CHUNG cho `main.ts` (server thường) và `serverless.ts` (Vercel) — để 2 chế độ KHÔNG lệch
 * nhau: prefix `api/v1`, CORS, body parser 5mb + rawBody, pipe/interceptor/filter toàn cục.
 */
export async function configureApp(
  app: NestExpressApplication,
  opts: ConfigureAppOptions,
): Promise<void> {
  // PHẢI đứng trước mọi middleware khác — pipe đọc đường dẫn từ đây.
  app.use(requestPathMiddleware)
  // SPIKE RLS: request chạy trong tenant cấu hình (TRINITY_DEFAULT_TENANT_ID). Chỉ có tác dụng khi TRINITY_TENANT_RLS=on.
  app.use(tenantMiddleware)


  const captureRawBody = (req: unknown, _res: unknown, buf: Buffer): void => {
    if (buf && buf.length) (req as { rawBody?: Buffer }).rawBody = buf
  }
  app.useBodyParser('json', { limit: '5mb', verify: captureRawBody })
  app.useBodyParser('urlencoded', { extended: true, limit: '5mb' })

  opts.afterBodyParser?.()

  app.enableCors({ origin: corsOrigin, credentials: true })
  app.setGlobalPrefix('api/v1')

  // Ảnh đại diện do `services/auth` phục vụ (`useStaticAssets` trong main.ts của nó).
  if (opts.serveUploads) {
    app.useStaticAssets(path.join(process.cwd(), 'uploads'), { prefix: '/uploads' })
  }

  app.useGlobalPipes(new ServiceAwareValidationPipe())

  // Mọi service dùng ĐÚNG cùng bộ này — gộp lại chỉ còn 1 bản.
  app.useGlobalInterceptors(app.get(LoggingInterceptor))
  app.useGlobalFilters(app.get(ElkExceptionFilter))

  if (opts.swagger) {
    const config = new DocumentBuilder()
      .setTitle('Trinity CRM — Monolith')
      .setDescription('auth + crm + payroll + notification in a single process')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build()
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config))
  }
}

/**
 * RBAC quyền + phạm vi — boot-check deny-by-default.
 * `app.init()` chạy trước (idempotent) để route audit thấy đủ mọi controller.
 * Trả danh sách lỗi (rỗng = đạt); caller quyết định `process.exit` (server thường) hay throw (serverless).
 */
export async function initAndAudit(app: NestExpressApplication): Promise<string[]> {
  await app.init()
  const { missing, exportWithoutPerm } = auditRoutes(app)
  return [...missing, ...exportWithoutPerm]
}

/**
 * Secret còn để giá trị mẫu `change-me-*` (chép nguyên `.env.example`) hoặc quá ngắn ⇒ ai đọc repo cũng ký được JWT quản trị.
 * Chế độ máy chủ (VPS/Docker) ở production từ chối khởi động khi có lỗi này. Trả danh sách lỗi (không chứa giá trị secret).
 */
export function insecureSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const placeholder = (v: string | undefined) => !!v && /change-me/i.test(v);
  for (const k of ['JWT_SECRET', 'SERVICE_SECRET', 'INTERNAL_SERVICE_SECRET'] as const) {
    const v = env[k]?.trim();
    if (!v) continue;
    if (placeholder(v)) out.push(`${k} vẫn là giá trị mẫu change-me-* — sinh mới bằng: openssl rand -hex 32`);
    else if (v.length < 32) out.push(`${k} ngắn hơn 32 ký tự — sinh mới bằng: openssl rand -hex 32`);
  }
  if (placeholder(env.INTEGRATIONS_SECRET_KEY)) out.push('INTEGRATIONS_SECRET_KEY vẫn là giá trị mẫu — sinh mới bằng: openssl rand -base64 32');
  if (placeholder(env.DATABASE_URL) || placeholder(env.POSTGRES_PASSWORD)) out.push('Mật khẩu Postgres vẫn là giá trị mẫu change-me-db-password');
  if (!env.JWT_SECRET?.trim()) out.push('Thiếu JWT_SECRET');
  return out;
}
