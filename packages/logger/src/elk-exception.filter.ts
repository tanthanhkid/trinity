import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common'
import * as winston from 'winston'
import { ELK_LOGGER } from './logging.interceptor'
import { redactUrl } from './redact-url'
import { reportServerError } from './server-error-reporter'

@Catch()
export class ElkExceptionFilter implements ExceptionFilter {
  constructor(@Inject(ELK_LOGGER) private readonly logger: winston.Logger) {}

  catch(rawException: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    // A signed-in request without a company context is a server bug (500, reported), not "not found".
    const exception = translateTenantError(rawException, Boolean(ctx.getRequest()?.user))
    const response = ctx.getResponse()
    const request = ctx.getRequest()

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR

    // ValidationPipe ném BadRequestException với body = { message: [...], error: 'Bad Request' }
    // nhưng `exception.message` chỉ là "Bad Request Exception" (generic).
    // Phải dùng getResponse() để giữ nguyên mảng chi tiết lỗi.
    let message: string | string[] = 'Internal server error'
    let errorLabel: string | undefined
    // Lỗi từng trường (`{ errors: { khoá: 'lý do' } }`, vd tính năng tuỳ biến) — giữ cho 4xx để FE hiện đúng ô.
    let fieldErrors: unknown
    if (exception instanceof HttpException) {
      const body = exception.getResponse()
      if (typeof body === 'string') {
        message = body
      } else if (body && typeof body === 'object') {
        const b = body as { message?: string | string[]; error?: string }
        if (b.message !== undefined) message = b.message
        else message = exception.message
        if (typeof b.error === 'string') errorLabel = b.error
        const extra = (body as { errors?: unknown }).errors
        if (status < 500 && extra && typeof extra === 'object') fieldErrors = extra
      } else {
        message = exception.message
      }
    }

    const correlationId = request.headers?.['x-correlation-id'] || 'N/A'
    const isServerError = status >= 500
    const logMeta: Record<string, unknown> = {
      correlation_id: correlationId,
      status_code: status,
      method: request.method,
      url: redactUrl(request.url),
      error_message: Array.isArray(message) ? message.join('; ') : message,
      user_id: request.user?.id || 'anonymous',
    }
    if (isServerError) {
      logMeta.error_stack = exception instanceof Error ? exception.stack : undefined
      this.logger.error('Unhandled Exception', logMeta)
      try {
        reportServerError(exception, {
          method: request.method,
          status,
          url: redactUrl(request.url),
          userId: request.user?.userId ?? request.user?.id ?? null,
        })
      } catch {
        /* never break the response */
      }
    } else {
      // 4xx là expected (validation, auth hết hạn, rate limit...): log warn, không kèm stack
      this.logger.warn('HTTP Client Error', logMeta)
    }

    response.status(status).json({
      statusCode: status,
      message,
      error:
        status >= 500
          ? 'Internal Server Error'
          : (errorLabel ?? (Array.isArray(message) ? 'Bad Request' : message)),
      ...(fieldErrors !== undefined ? { errors: fieldErrors } : {}),
    })
  }
}

/**
 * Multi-tenant errors (matched by name/message so this package does not depend on @trinity/prisma):
 *  - no company context on a public route (unknown `cid`, etc.) → 404, nothing to see here;
 *  - database triggers guarding cross-company uniqueness → 409 with a readable message.
 */
export function translateTenantError(e: unknown, authenticated = false): unknown {
  if (!(e instanceof Error) || e instanceof HttpException) return e
  // Signed-in requests always have a company: missing one there is a server bug — keep it a reported 500.
  if (e.name === 'MissingCompanyContextError') {
    return authenticated ? e : new HttpException('Không tìm thấy', HttpStatus.NOT_FOUND)
  }
  const msg = e.message || ''
  if (msg.includes('TRINITY_EMAIL_TAKEN')) {
    return new HttpException('Email này đã được dùng cho một công ty khác trên Trinity', HttpStatus.CONFLICT)
  }
  if (msg.includes('TRINITY_ROUTE_TAKEN')) {
    return new HttpException('Trang/kênh này đã được một công ty khác kết nối với Trinity', HttpStatus.CONFLICT)
  }
  if (msg.includes('TRINITY_SINGLE_USER')) {
    return new HttpException('Mỗi công ty trên Trinity chỉ có một tài khoản chủ', HttpStatus.CONFLICT)
  }
  return e
}
