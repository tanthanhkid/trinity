import { ValidationPipe } from '@nestjs/common'
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common'

import { requestPathStorage } from './request-path.context'

/**
 * Tiền tố route của các service (auth, payroll, notification) KHÔNG bật `forbidNonWhitelisted`.
 *
 * Khớp theo tiền tố route; thêm route mới vào đúng nhóm service của nó.
 *
 * ⚠️ `/api/v1/employees` (Payroll) KHÁC `/api/v1/management/employees` (CRM) —
 * khớp theo tiền tố nên không nhầm, nhưng đừng rút gọn thành `employees`.
 */
const LENIENT_PREFIXES = [
  // auth
  '/api/v1/auth',
  '/api/v1/public/auth',
  '/api/v1/api-keys',
  '/api/v1/users',
  '/api/v1/roles',
  '/api/v1/teams',
  // payroll
  '/api/v1/employees',
  '/api/v1/kpi',
  '/api/v1/payslips',
  '/api/v1/salary-rules',
  // notification
  '/api/v1/notifications',
  '/api/v1/templates',
]

/**
 * Giữ ĐÚNG cấu hình ValidationPipe của từng service sau khi gộp process.
 *
 * `services/crm` và `services/commerce` chạy `forbidNonWhitelisted: true`; các
 * service còn lại thì không. Một pipe toàn cục duy nhất sẽ đổi hành vi của một
 * trong hai nhóm:
 *
 * - Siết tất cả → request đang chạy được mà gửi kèm field thừa sẽ bắt đầu bị
 *   400. Là REGRESSION nhìn thấy được với người dùng.
 * - Nới tất cả → crm/commerce mất chốt bắt lỗi "DTO thiếu decorator
 *   class-validator". `whitelist: true` vẫn lọc sạch field lạ
 *   nên không phải lỗ hổng dữ liệu, nhưng mất tiếng chuông báo sớm.
 *
 * Nên chọn theo route để không nhóm nào đổi hành vi.
 */
export class ServiceAwareValidationPipe implements PipeTransform {
  private readonly lenient = new ValidationPipe({ whitelist: true, transform: true })
  private readonly strict = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  })

  transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const path = requestPathStorage.getStore() ?? ''
    const pipe = LENIENT_PREFIXES.some((p) => path.startsWith(p)) ? this.lenient : this.strict
    return pipe.transform(value, metadata)
  }
}
