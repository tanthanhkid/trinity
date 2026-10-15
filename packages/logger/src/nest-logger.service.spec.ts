/**
 * Unit tests cho ElkNestLogger.serializeContext
 *
 * Mục đích: verify fix ELK mapper_parsing_exception —
 * object context phải được stringify thành string trước khi gửi lên ES.
 * ELK index template map fields.context là scalar `text`.
 */

import { ElkNestLogger } from './nest-logger.service'
import { createElkLogger } from './elk-logger'

// Mock toàn bộ elk-logger để test không cần Winston/ES thật
jest.mock('./elk-logger', () => ({
  createElkLogger: jest.fn(),
}))

const mockWinstonLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
}

;(createElkLogger as jest.Mock).mockReturnValue(mockWinstonLogger)

/** Truy cập private method qua type cast để test trực tiếp */
function callSerializeContext(
  instance: ElkNestLogger,
  ctx: string | object | undefined | null,
): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (instance as any).serializeContext(ctx)
}

describe('ElkNestLogger.serializeContext', () => {
  let logger: ElkNestLogger

  beforeEach(() => {
    jest.clearAllMocks()
    logger = new ElkNestLogger({ service: 'test' })
  })

  it('string passthrough — giữ nguyên không đổi', () => {
    expect(callSerializeContext(logger, 'UsersService')).toBe('UsersService')
  })

  it('empty string passthrough', () => {
    expect(callSerializeContext(logger, '')).toBe('')
  })

  it('undefined → trả về undefined', () => {
    expect(callSerializeContext(logger, undefined)).toBeUndefined()
  })

  it('null → trả về undefined', () => {
    expect(callSerializeContext(logger, null)).toBeUndefined()
  })

  it('BigInt trong context không làm ném lỗi', () => {
    expect(callSerializeContext(logger, { id: 12n })).toBe('{"id":"12"}')
  })

  it('vòng tham chiếu không làm ném lỗi', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => callSerializeContext(logger, a)).not.toThrow()
  })

  it('flat object → JSON.stringify', () => {
    const ctx = { actor_user_id: 99, target_user_id: 1, action: 'reset-password' }
    const result = callSerializeContext(logger, ctx)
    expect(result).toBe(JSON.stringify(ctx))
    expect(typeof result).toBe('string')
  })

  it('nested object → stringify đúng (không truncate)', () => {
    const ctx = {
      actor: { userId: 1, role: 'super_admin' },
      target: { id: 2, email: 't***@example.vn' },
      timestamp: '2026-05-05T00:00:00.000Z',
    }
    const result = callSerializeContext(logger, ctx)
    expect(result).toBe(JSON.stringify(ctx))
    // Confirm nested keys còn nguyên
    const parsed = JSON.parse(result as string)
    expect(parsed.actor.userId).toBe(1)
    expect(parsed.target.email).toBe('t***@example.vn')
  })

  it('audit log object thực từ resetPassword — stringify thành string (không phải object)', () => {
    const auditCtx = {
      actor_user_id: 99,
      actor_role: 'super_admin',
      target_user_id: 1,
      target_email: 't***@example.vn',
      custom_password_provided: false,
      timestamp: new Date().toISOString(),
    }
    const result = callSerializeContext(logger, auditCtx)
    // ELK text field nhận string, KHÔNG nhận object
    expect(typeof result).toBe('string')
    expect(result).toContain('"target_email"')
    expect(result).toContain('"actor_user_id":99')
  })
})

describe('ElkNestLogger — log methods gọi serializeContext đúng', () => {
  let logger: ElkNestLogger

  beforeEach(() => {
    jest.clearAllMocks()
    logger = new ElkNestLogger({ service: 'test' })
  })

  it('log() với object context → winston.info nhận context là string', () => {
    const ctx = { key: 'value' }
    logger.log('test message', ctx)
    expect(mockWinstonLogger.info).toHaveBeenCalledWith(
      'test message',
      { context: JSON.stringify(ctx) },
    )
  })

  it('warn() với object context → winston.warn nhận context là string', () => {
    const ctx = { actor_user_id: 1, action: 'delete' }
    logger.warn('audit warn', ctx)
    expect(mockWinstonLogger.warn).toHaveBeenCalledWith(
      'audit warn',
      { context: JSON.stringify(ctx) },
    )
  })

  it('log() với string context → winston.info nhận context nguyên string', () => {
    logger.log('message', 'UsersService')
    expect(mockWinstonLogger.info).toHaveBeenCalledWith(
      'message',
      { context: 'UsersService' },
    )
  })

  it('error() với object context → winston.error nhận context là string', () => {
    const ctx = { module: 'AuthService' }
    logger.error('something failed', 'stack trace', ctx)
    expect(mockWinstonLogger.error).toHaveBeenCalledWith(
      'something failed',
      { trace: 'stack trace', context: JSON.stringify(ctx) },
    )
  })
})

describe('ElkNestLogger.error — object rơi vào slot `trace` (tránh mapper_parsing_exception ở ELK)', () => {
  let logger: ElkNestLogger

  beforeEach(() => {
    jest.clearAllMocks()
    logger = new ElkNestLogger({ service: 'test' })
  })

  it('.error(msg, objectAsTrace) — object KHÔNG BAO GIỜ lọt ra winston, được đưa vào context dạng string', () => {
    const metadata = { target_user_id: 1, synced: 0, retry_at: null }
    logger.error('[sync-job] failed', metadata)
    const call = mockWinstonLogger.error.mock.calls[0]
    expect(call[0]).toBe('[sync-job] failed')
    expect(call[1].trace).toBeUndefined()
    expect(typeof call[1].context).toBe('string')
    // Round-trip: parse lại phải ra đúng object ban đầu — không mất dữ liệu.
    expect(JSON.parse(call[1].context)).toEqual(metadata)
  })

  it('.error(msg, objectAsTrace) — không có object nào (kể cả rỗng) đi thẳng ra winston.error', () => {
    logger.error('[import-job] upstream error', { status: 500, body: 'timeout' })
    const [, meta] = mockWinstonLogger.error.mock.calls[0]
    for (const value of Object.values(meta)) {
      expect(typeof value === 'object' ? value : null).toBeNull()
    }
  })

  it('.error(msg, realStackString) — KHÔNG regression: trace string thật giữ nguyên, không rơi vào context', () => {
    logger.error('DB connection lost', 'Error: connect ECONNREFUSED\n    at Socket.<anonymous>')
    expect(mockWinstonLogger.error).toHaveBeenCalledWith('DB connection lost', {
      trace: 'Error: connect ECONNREFUSED\n    at Socket.<anonymous>',
      context: undefined,
    })
  })

  it('.error(msg, stackString, contextObject) — KHÔNG regression: hành vi 3-arg cũ giữ nguyên y hệt', () => {
    const ctx = { requestId: 'abc-123' }
    logger.error('Request failed', 'stack-trace-here', ctx)
    expect(mockWinstonLogger.error).toHaveBeenCalledWith('Request failed', {
      trace: 'stack-trace-here',
      context: JSON.stringify(ctx),
    })
  })

  it('.error(msg, errorInstance) — Error thật đi qua trace dạng stack string, KHÔNG JSON.stringify thành {}', () => {
    const err = new Error('boom')
    logger.error('session cleanup: lỗi khi kết thúc phiên', err)
    const [, meta] = mockWinstonLogger.error.mock.calls[0]
    expect(typeof meta.trace).toBe('string')
    expect(meta.trace).toContain('boom')
    expect(meta.context).toBeUndefined()
  })

  it('.error(msg, errorInstance) không có stack (edge case) → fallback sang message, vẫn là string', () => {
    const err = new Error('no-stack-case')
    delete (err as { stack?: string }).stack
    logger.error('edge case', err)
    const [, meta] = mockWinstonLogger.error.mock.calls[0]
    expect(meta.trace).toBe('no-stack-case')
  })

  it('.error(msg, objectAsTrace, contextObject) — merge cả 2, context thắng khi trùng key, round-trip đủ dữ liệu', () => {
    const traceMeta = { scriptId: 1, status: 'failed' }
    const contextMeta = { status: 'overridden', requestId: 'xyz' }
    logger.error('merge case', traceMeta, contextMeta)
    const [, meta] = mockWinstonLogger.error.mock.calls[0]
    expect(meta.trace).toBeUndefined()
    expect(JSON.parse(meta.context)).toEqual({ scriptId: 1, status: 'overridden', requestId: 'xyz' })
  })
})
