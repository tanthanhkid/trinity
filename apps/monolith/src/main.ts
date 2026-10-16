import './instrument'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { MonolithModule } from './app.module'
import { NEST_CREATE_OPTIONS, configureApp, initAndAudit, insecureSecrets } from './bootstrap-app'
import { ElkNestLogger } from '@trinity/logger'

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
  await app.listen(port)
  elkLogger.log(`Trinity monolith running on port ${port}`, 'Bootstrap')
}
bootstrap()
