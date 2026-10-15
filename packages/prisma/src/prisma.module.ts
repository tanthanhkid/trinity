import { Module, Global } from '@nestjs/common'
import { PrismaService } from './prisma.service'
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
@Global()
@Module({
  providers: [PrismaService, IntegrationAuditService, IntegrationEventsService],
  exports: [PrismaService, IntegrationAuditService, IntegrationEventsService],
})
export class PrismaModule {}
