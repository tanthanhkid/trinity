import { Module, Global, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { syncBus, syncDisabled } from './sync/sync-bus'
import { PrismaService, createPrismaService } from './prisma.service'
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
  providers: [
    // Factory → the multi-tenant routing proxy (see prisma.service.ts). Same token, same type for injectors.
    { provide: PrismaService, useFactory: createPrismaService },
    IntegrationAuditService,
    IntegrationEventsService,
  ],
  exports: [PrismaService, IntegrationAuditService, IntegrationEventsService],
})
export class PrismaModule implements OnModuleInit, OnModuleDestroy {
  /** G12b: nghe `NOTIFY` để vô hiệu cache giữa các tiến trình. Không có DB / serverless / `TRINITY_SYNC=off` ⇒ không nghe. */
  async onModuleInit(): Promise<void> {
    if (syncDisabled()) return
    // Không chặn khởi động: nối thất bại tự báo lỗi rõ và thử lại nền (start chờ tối đa 5 giây cho lần nối đầu).
    void syncBus.start()
  }

  async onModuleDestroy(): Promise<void> {
    await syncBus.stop()
  }
}
