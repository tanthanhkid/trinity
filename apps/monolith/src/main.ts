import './instrument'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { MonolithModule } from './app.module'
import { NEST_CREATE_OPTIONS, configureApp, initAndAudit, insecureSecrets } from './bootstrap-app'
import { ElkNestLogger } from '@trinity/logger'
import { clientIpStartupProblems, tunnelListenProblem } from '@trinity/rbac-nest'

async function bootstrap() {
  const elkLogger = new ElkNestLogger({ service: 'monolith' })

  // Production: không chạy với secret mẫu / quá ngắn (xem `insecureSecrets`). Bản Vercel sinh secret riêng theo README.
  if (process.env.NODE_ENV === 'production') {
    const bad = insecureSecrets(process.env)
    if (bad.length) {
      elkLogger.error(`Không khởi động: cấu hình secret không an toàn:\n- ${bad.join('\n- ')}`, undefined, 'Bootstrap')
      process.exit(1)
    }
  }

  // IP của khách (docs/deployment.md, mục "Client IP"): `TRUSTED_PROXY` sai, hoặc còn cờ cũ `*_TRUST_*` mà chưa đặt
  // `TRUSTED_PROXY` ⇒ không khởi động (cờ cũ không được tự đổi sang giá trị mới). Áp mọi NODE_ENV.
  const ipProblems = clientIpStartupProblems(process.env)
  if (ipProblems.length) {
    elkLogger.error(`Không khởi động: cấu hình IP của khách sai:\n- ${ipProblems.join('\n- ')}`, undefined, 'Bootstrap')
    process.exit(1)
  }

  // `bodyParser: false` + `useBodyParser` — yêu cầu CHẶT NHẤT trong các service (crm).
  const app = await NestFactory.create<NestExpressApplication>(MonolithModule, {
    logger: elkLogger,
    ...NEST_CREATE_OPTIONS,
  })

  await configureApp(app, {
    serveUploads: true,
    // Tài liệu API (Swagger) chỉ bật mặc định ngoài production; production bật bằng SWAGGER_ENABLED=true.
    swagger: process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === 'true',
    afterBodyParser: () => {
      app.enableShutdownHooks()
    },
  })

  // `app.init()` chạy trước `app.listen()` — route audit thấy đủ mọi controller trước khi mở cổng.
  const problems = await initAndAudit(app)
  if (problems.length) {
    elkLogger.error(`RBAC: route thiếu quyền:\n${problems.join('\n')}`, undefined, 'Bootstrap')
    process.exit(1)
  }

  if (!process.env.INTERNAL_SERVICE_SECRET && !process.env.SERVICE_SECRET) {
    elkLogger.warn(
      'Chưa đặt INTERNAL_SERVICE_SECRET/SERVICE_SECRET: mọi route @Internal (service -> monolith) sẽ trả 401',
      'Bootstrap',
    )
  }

  const port = process.env.PORT || 4000
  // `LISTEN_HOST` trống = mọi giao diện (như cũ). `TRUSTED_PROXY=cloudflare-tunnel` bắt buộc loopback.
  const host = process.env.LISTEN_HOST?.trim()
  if (host) await app.listen(port, host)
  else await app.listen(port)
  const bound = app.getHttpServer().address()
  const tunnelProblem = tunnelListenProblem(typeof bound === 'object' && bound ? bound.address : null, process.env)
  if (tunnelProblem) {
    elkLogger.error(`Không khởi động: ${tunnelProblem}`, undefined, 'Bootstrap')
    process.exit(1)
  }
  elkLogger.log(`Trinity monolith running on port ${port}`, 'Bootstrap')
}
bootstrap()
