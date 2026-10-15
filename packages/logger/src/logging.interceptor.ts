import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from '@nestjs/common'
import { Observable, tap } from 'rxjs'
import * as winston from 'winston'
import { redactUrl } from './redact-url'

export const ELK_LOGGER = 'ELK_LOGGER'

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(@Inject(ELK_LOGGER) private readonly logger: winston.Logger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest()
    const { method, url, headers, ip } = req
    const correlationId = headers['x-correlation-id'] || 'N/A'
    const userId = req.user?.id || 'anonymous'
    const startTime = Date.now()

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse()
          const duration = Date.now() - startTime
          // Chỉ log requests chậm (>500ms) hoặc lỗi, bỏ health check
          if (duration > 500 && !url.includes('/health')) {
            this.logger.warn('Slow Request', {
              correlation_id: correlationId,
              method,
              url: redactUrl(url),
              status_code: res.statusCode,
              duration_ms: duration,
              user_id: userId,
              ip,
            })
          }
        },
        // Không log ở đây — ElkExceptionFilter đã log kèm response body chi tiết + chọn
        // level theo status (5xx=error, 4xx=warn). Log trùng ở interceptor làm ELK đầy
        // error giả (vd: 401 token hết hạn, 429 rate limit).
      }),
    )
  }
}
