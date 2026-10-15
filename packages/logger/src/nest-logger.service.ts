import { LoggerService as NestLoggerService } from '@nestjs/common'
import * as winston from 'winston'
import { createElkLogger, ElkLoggerOptions } from './elk-logger'

/**
 * NestJS-compatible logger that sends logs to ELK stack.
 * Drop-in replacement for NestJS built-in Logger.
 */
export class ElkNestLogger implements NestLoggerService {
  private readonly logger: winston.Logger

  /** `shared`: dùng chung một winston logger (module truyền `ELK_LOGGER`) — tránh mở hai logger cùng một file transport. */
  constructor(options: ElkLoggerOptions, shared?: winston.Logger) {
    this.logger = shared ?? createElkLogger(options)
  }

  /**
   * Chuyển context sang string trước khi gửi lên ELK.
   * ELK index template map fields.context là `text` (scalar string).
   * Nếu truyền object (vd audit log), Elasticsearch báo mapper_parsing_exception.
   * Rule: object → JSON.stringify, undefined → undefined, string → giữ nguyên.
   */
  private serializeContext(context?: string | object): string | undefined {
    if (context === undefined || context === null) return undefined
    if (typeof context === 'string') return context
    if (context instanceof Error) return context.stack ?? context.message
    try {
      return JSON.stringify(context, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    } catch {
      // vòng tham chiếu… — log không được phép làm sập request
      return String(context)
    }
  }

  log(message: string, context?: string | object): void {
    this.logger.info(message, { context: this.serializeContext(context) })
  }

  /**
   * Chữ ký gốc Nest `error(message, trace?, context?)` — `trace` LẼ RA là
   * stack-trace string. Nhưng nhiều call-site trong repo gọi
   * `.error(msg, metadataObject)` giống pattern `.warn(msg, metadataObject)`
   * — object đó rơi vào slot `trace`, TRƯỚC ĐÂY đi thẳng ra winston KHÔNG
   * qua serialize nào → ELK mapper_parsing_exception (field map `text`),
   * cùng lớp lỗi với context nhưng ở tham số khác.
   * Rule (giữ nguyên hành vi cũ cho case trace-string thật):
   * - trace string/undefined → giữ nguyên, KHÔNG đổi.
   * - trace là Error instance → coi là stack trace thật, lấy `.stack`/
   *   `.message` (string) — KHÔNG JSON.stringify (Error → JSON.stringify
   *   ra `'{}'`, mất sạch message/stack).
   * - trace là object khác (metadata, ý định giống `.warn()`) → merge vào
   *   `context` thật (nếu có) rồi cùng đi qua serializeContext — không để
   *   object nào lọt ra winston chưa serialize.
   */
  error(message: string, trace?: string | object, context?: string | object): void {
    if (trace === undefined || typeof trace === 'string') {
      this.logger.error(message, { trace, context: this.serializeContext(context) })
      return
    }
    const traceStr = trace instanceof Error ? trace.stack ?? trace.message : undefined
    const mergedContext = traceStr === undefined ? this.mergeTraceIntoContext(trace, context) : context
    this.logger.error(message, { trace: traceStr, context: this.serializeContext(mergedContext) })
  }

  /**
   * Merge object "trace" (thực chất là metadata) với `context` thật nếu
   * caller truyền CẢ 2 — chưa có call-site nào làm vậy hiện tại, xử lý an
   * toàn để không mất dữ liệu nếu về sau có. `context` object thắng khi
   * trùng key; `context` string (không khớp interface, hiếm) giữ riêng dưới
   * `context_message` để không đè mất metadata gốc.
   */
  private mergeTraceIntoContext(traceObj: object, context?: string | object): object {
    if (context === undefined || context === null) return traceObj
    if (typeof context === 'string') return { ...traceObj, context_message: context }
    return { ...traceObj, ...context }
  }

  warn(message: string, context?: string | object): void {
    this.logger.warn(message, { context: this.serializeContext(context) })
  }

  debug(message: string, context?: string | object): void {
    this.logger.debug(message, { context: this.serializeContext(context) })
  }

  verbose(message: string, context?: string | object): void {
    this.logger.verbose(message, { context: this.serializeContext(context) })
  }

  getWinstonLogger(): winston.Logger {
    return this.logger
  }
}
