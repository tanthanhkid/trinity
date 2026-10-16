import type { IncomingMessage, ServerResponse } from 'node:http'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ElkNestLogger } from '@trinity/logger'

import { MonolithModule } from './app.module'
import { initMonitoring } from './monitoring'
import { withPooledParams } from './runtime'
import { NEST_CREATE_OPTIONS, configureApp, initAndAudit } from './bootstrap-app'

/**
 * Điểm vào SERVERLESS (Vercel): trả handler Node `(req, res)` của Express app do Nest dựng.
 *
 * KHÁC `main.ts`: KHÔNG `listen`, KHÔNG Swagger, KHÔNG
 * phục vụ `/uploads` từ đĩa (file qua `@trinity/storage`), KHÔNG shutdown hook (hàm tự bị đóng). Cấu hình còn lại
 * dùng CHUNG `configureApp` với `main.ts` nên không lệch giữa 2 chế độ.
 *
 * `init()` đúng 1 lần mỗi instance: Promise cache trên `globalThis` (Next dev/HMR hoặc nhiều bundle nạp file
 * này 2 lần vẫn dùng chung 1 app). Lỗi khởi động KHÔNG bị cache — lần gọi sau thử dựng lại.
 */
export type ServerlessHandler = (req: IncomingMessage, res: ServerResponse) => void

const CACHE_KEY = Symbol.for('trinity.monolith.serverless.handler')
type Cache = { [CACHE_KEY]?: Promise<ServerlessHandler> }

async function createHandler(): Promise<ServerlessHandler> {
  // Có gọi `getHandler()` là đang ở serverless — để mọi module tự gate timer/Redis/… theo cùng một cờ.
  process.env.TRINITY_RUNTIME ??= 'serverless'
  initMonitoring()

  // Neon pooled: bổ sung `pgbouncer=true` + sàn `connection_limit=3` cho PrismaService (nó đọc DATABASE_URL lúc dựng client).
  if (process.env.DATABASE_URL) process.env.DATABASE_URL = withPooledParams(process.env.DATABASE_URL)

  const logger = new ElkNestLogger({ service: 'monolith' })
  // Vercel keeps only the first ~256 log lines per invocation. Nest's ~250 "Mapped route" info lines would push the real
  // error out of the log, so drop info/debug output in serverless (errors and warnings stay). TRINITY_LOG_VERBOSE=1 restores it.
  if (process.env.TRINITY_LOG_VERBOSE !== '1') {
    Object.assign(logger, { log: () => undefined, debug: () => undefined, verbose: () => undefined })
  }
  const app = await NestFactory.create<NestExpressApplication>(MonolithModule, {
    logger,
    ...NEST_CREATE_OPTIONS,
  })
  await configureApp(app, { serveUploads: false, swagger: false })

  const problems = await initAndAudit(app)
  if (problems.length) {
    // Không `process.exit` (giết cả instance dùng chung): fail to, mỗi request 500 tới khi sửa.
    throw new Error(`RBAC: route thiếu quyền:\n${problems.join('\n')}`)
  }

  const express = app.getHttpAdapter().getInstance() as ServerlessHandler
  return (req, res) => express(req, res)
}

export function getHandler(): Promise<ServerlessHandler> {
  const g = globalThis as Cache
  if (!g[CACHE_KEY]) {
    const p = createHandler()
    g[CACHE_KEY] = p
    p.catch(() => {
      if (g[CACHE_KEY] === p) delete g[CACHE_KEY]
    })
  }
  return g[CACHE_KEY]!
}
