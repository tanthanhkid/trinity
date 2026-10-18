import { Module, Global } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { withTenantRls } from './tenant'
import { IntegrationAuditService } from './integrations/integration-audit.service'
import { IntegrationEventsService } from './integrations/integration-events.service'

// PrismaService tách ra `prisma.service.ts` để các service dùng chung (integrations/*) import được mà
// không tạo vòng import với module này. Re-export giữ nguyên đường import cũ.
export { PrismaService }

/**
 * `IntegrationAuditService` / `IntegrationEventsService` chỉ phụ thuộc PrismaService và được mọi
 * service trong monolith dùng chung (webhook, MCP, các điểm ghi nghiệp vụ) nên đăng ký Global ở đây —
 * service nào cũng inject được mà không import chéo giữa các thư mục `services/*`.
 */
/**
 * SPIKE RLS: `TRINITY_TENANT_RLS=on` ⇒ PrismaService là client có extension đặt `app.tenant_id` mỗi transaction
 * (xem `./tenant`). Chỉ bật cùng migration 0016 và role DB không có BYPASSRLS; tắt ⇒ client cũ y nguyên.
 */
export function createPrismaService(env: NodeJS.ProcessEnv = process.env): PrismaService {
  const base = new PrismaService()
  return env.TRINITY_TENANT_RLS === 'on' ? (withTenantRls(base) as unknown as PrismaService) : base
}

@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: () => createPrismaService() }, IntegrationAuditService, IntegrationEventsService],
  exports: [PrismaService, IntegrationAuditService, IntegrationEventsService],
})
export class PrismaModule {}
