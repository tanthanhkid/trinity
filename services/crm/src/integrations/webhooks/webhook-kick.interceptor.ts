import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Serverless: không có timer 10s nên webhook ra phải được kích ngay sau khi request GHI hoàn tất (lúc đó
 * transaction nghiệp vụ + dòng outbox đã commit). Chỉ chạm khi `TRINITY_RUNTIME=serverless` và cờ webhook bật —
 * `kick()` tự no-op ở mọi trường hợp khác nên với tiến trình dài interceptor này không làm gì. Lỗi gửi không bao giờ ảnh hưởng response.
 */
@Injectable()
export class WebhookKickInterceptor implements NestInterceptor {
  constructor(private readonly dispatcher: WebhookDispatcherService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const method = String(context.switchToHttp().getRequest<{ method?: string }>()?.method ?? '').toUpperCase();
    if (!WRITE_METHODS.has(method)) return next.handle();
    return next.handle().pipe(tap({ complete: () => this.dispatcher.kick() }));
  }
}
