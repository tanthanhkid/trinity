import { Module } from '@nestjs/common'
import { RbacModule } from '@trinity/rbac-nest'

import { AppModule as AuthModule } from '../../../services/auth/src/app.module'
import { AppModule as CrmModule } from '../../../services/crm/src/app.module'
import { AppModule as CommerceModule } from '../../../services/commerce/src/app.module'
import { AppModule as PayrollModule } from '../../../services/payroll/src/app.module'
import { AppModule as NotificationModule } from '../../../services/notification/src/app.module'
import { InternalPortsModule } from './internal-ports/internal-ports.module'

/**
 * Gộp các service NestJS (auth, crm, commerce, payroll, notification) vào 1 process.
 *
 * Mỗi service vào đây nguyên vẹn dưới dạng 1 module — các nhóm route rời nhau
 * (`/auth`, `/contacts`, `/products`, `/kpi`, `/notifications`...) nên gộp không
 * sinh va chạm đường dẫn. Một process chỉ gánh 1 Node runtime + 1 Prisma query
 * engine thay vì mỗi service một bản.
 *
 * Lưu ý khi gộp (đừng "dọn dẹp" mất):
 *
 * 1. `RbacModule` đăng ký `PermissionGuard` qua `APP_GUARD` — deny-by-default:
 *    route thiếu `@Can/@AuthOnly/@Public/@Internal` bị 403 và `main.ts` từ chối
 *    khởi động.
 *
 * 2. `InternalPortsModule` nối các "cổng" gọi nội bộ giữa service (chuông WS,
 *    thông báo phiếu lương) bằng DI. Gỡ nó đi = các luồng đó log ERROR, không im lặng.
 */
@Module({
  imports: [
    RbacModule,
    AuthModule,
    CrmModule,
    CommerceModule,
    PayrollModule,
    NotificationModule,
    InternalPortsModule,
  ],
})
export class MonolithModule {}
