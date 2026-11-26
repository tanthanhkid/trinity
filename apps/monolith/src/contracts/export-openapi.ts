/**
 * Xuất OpenAPI của monolith ra `server/contracts/openapi.json` (hợp đồng đóng băng, docs/rust/PLAN.md mục 6.1).
 *
 *   pnpm --filter @trinity/monolith contracts:openapi          # ghi lại file
 *   pnpm --filter @trinity/monolith contracts:openapi --check  # so với file đã commit, lệch thì thoát 1
 *
 * Không cần DB/Redis: chỉ dựng app (không `init`, không `listen`) rồi gọi `SwaggerModule.createDocument`.
 * Đầu ra xác định: khoá object sắp theo thứ tự chữ, mảng giữ nguyên thứ tự Nest sinh.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

// Env tối thiểu để các module dựng được mà không chạm hạ tầng; không đè giá trị đã có.
process.env.NODE_ENV ??= 'test'
process.env.JWT_SECRET ??= 'contracts-export-secret'
process.env.INTERNAL_SERVICE_SECRET ??= 'contracts-export-internal'
process.env.SERVICE_SECRET ??= 'contracts-export-service'
process.env.DATABASE_URL ??= 'postgresql://x:x@127.0.0.1:1/x'
process.env.STORAGE_DRIVER ??= 'local'
process.env.STORAGE_LOCAL_ROOT ??= path.join(process.env.TMPDIR ?? '/tmp', 'trinity-contracts-storage')

function repoRoot(): string {
  let d = __dirname
  while (!fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) {
    const up = path.dirname(d)
    if (up === d) throw new Error('không thấy pnpm-workspace.yaml')
    d = up
  }
  return d
}
const OUT = path.join(repoRoot(), 'server/contracts/openapi.json')

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    )
  }
  return v
}

export async function buildOpenapi(): Promise<string> {
  // Import muộn: các module đọc env lúc nạp.
  const { MonolithModule } = await import('../app.module')
  const { NEST_CREATE_OPTIONS, configureApp } = await import('../bootstrap-app')
  const app = await NestFactory.create<NestExpressApplication>(MonolithModule, {
    logger: false,
    ...NEST_CREATE_OPTIONS,
  })
  try {
    await configureApp(app, { serveUploads: false, swagger: false })
    const config = new DocumentBuilder()
      .setTitle('Trinity CRM — Monolith')
      .setDescription('auth + crm + payroll + notification in a single process')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build()
    const doc = SwaggerModule.createDocument(app, config)
    return `${JSON.stringify(sortKeys(doc), null, 2)}\n`
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const text = await buildOpenapi()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (cur !== text) {
      console.error('server/contracts/openapi.json lệch với mã. Chạy: pnpm --filter @trinity/monolith contracts:openapi')
      process.exit(1)
    }
    console.log('openapi.json khớp')
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, text)
    console.log(`ghi ${OUT}`)
  }
  process.exit(0)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
