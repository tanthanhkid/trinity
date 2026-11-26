/**
 * Dùng chung cho các lệnh xuất hợp đồng (`server/contracts/*`): dựng monolith không cần DB/Redis, ghi hoặc `--check`.
 * Đầu ra xác định: khoá object sắp theo thứ tự chữ, mảng giữ nguyên thứ tự.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

// Env tối thiểu để các module dựng được mà không chạm hạ tầng; không đè giá trị đã có.
process.env.NODE_ENV ??= 'test'
process.env.JWT_SECRET ??= 'contracts-export-secret'
process.env.INTERNAL_SERVICE_SECRET ??= 'contracts-export-internal'
process.env.SERVICE_SECRET ??= 'contracts-export-service'
process.env.DATABASE_URL ??= 'postgresql://x:x@127.0.0.1:1/x'
process.env.STORAGE_DRIVER ??= 'local'
process.env.STORAGE_LOCAL_ROOT ??= path.join(process.env.TMPDIR ?? '/tmp', 'trinity-contracts-storage')

export function repoRoot(): string {
  let d = __dirname
  while (!fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) {
    const up = path.dirname(d)
    if (up === d) throw new Error('không thấy pnpm-workspace.yaml')
    d = up
  }
  return d
}

export function sortKeys(v: unknown): unknown {
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

/** Dựng app như `main.ts` (cùng `configureApp`), chưa `init`/`listen`. */
export async function createContractApp(): Promise<NestExpressApplication> {
  // Import muộn: các module đọc env lúc nạp.
  const { MonolithModule } = await import('../app.module')
  const { NEST_CREATE_OPTIONS, configureApp } = await import('../bootstrap-app')
  const app = await NestFactory.create<NestExpressApplication>(MonolithModule, {
    logger: false,
    ...NEST_CREATE_OPTIONS,
  })
  await configureApp(app, { serveUploads: false, swagger: false })
  return app
}

/** Ghi `server/contracts/<file>` hoặc (với `--check`) so với file đã commit. */
export async function runExport(file: string, command: string, build: () => Promise<string>): Promise<void> {
  const out = path.join(repoRoot(), 'server/contracts', file)
  const text = await build()
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
    if (cur !== text) {
      console.error(`server/contracts/${file} lệch với mã. Chạy: pnpm --filter @trinity/monolith ${command}`)
      const a = cur.split('\n')
      const b = text.split('\n')
      let shown = 0
      for (let i = 0; i < Math.max(a.length, b.length) && shown < 8; i++) {
        if (a[i] !== b[i]) {
          console.error(`  dòng ${i + 1}\n    file: ${(a[i] ?? '').slice(0, 200)}\n    mã:   ${(b[i] ?? '').slice(0, 200)}`)
          shown++
        }
      }
      process.exit(1)
    }
    console.log(`${file} khớp`)
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, text)
    console.log(`ghi ${out}`)
  }
  process.exit(0)
}

export function failOnError(p: Promise<void>): void {
  void p.catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
