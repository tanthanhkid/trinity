/**
 * Xuất OpenAPI của monolith ra `server/contracts/openapi.json` (hợp đồng đóng băng, docs/rust/PLAN.md mục 6.1).
 *
 *   pnpm --filter @trinity/monolith contracts:openapi          # ghi lại file
 *   pnpm --filter @trinity/monolith contracts:openapi --check  # so với file đã commit, lệch thì thoát 1
 */
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

import { createContractApp, failOnError, runExport, sortKeys } from './common'

async function build(): Promise<string> {
  const app = await createContractApp()
  try {
    const config = new DocumentBuilder()
      .setTitle('Trinity CRM — Monolith')
      .setDescription('auth + crm + payroll + notification in a single process')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build()
    return `${JSON.stringify(sortKeys(SwaggerModule.createDocument(app, config)), null, 2)}\n`
  } finally {
    await app.close().catch(() => undefined)
  }
}

failOnError(runExport('openapi.json', 'contracts:openapi', build))
