import { BadRequestException, InternalServerErrorException, type ArgumentsHost } from '@nestjs/common'
import type * as winston from 'winston'
import { ElkExceptionFilter } from './elk-exception.filter'

function run(exception: unknown): { status: number; body: Record<string, unknown> } {
  const out = { status: 0, body: {} as Record<string, unknown> }
  const response = { status: (s: number) => { out.status = s; return response }, json: (b: Record<string, unknown>) => { out.body = b } }
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ headers: {}, method: 'POST', url: '/x' }) }) } as unknown as ArgumentsHost
  const logger = { warn: jest.fn(), error: jest.fn() } as unknown as winston.Logger
  new ElkExceptionFilter(logger).catch(exception, host)
  return out
}

describe('ElkExceptionFilter', () => {
  it('4xx giữ lỗi từng trường `errors`', () => {
    const r = run(new BadRequestException({ statusCode: 400, message: 'Dữ liệu không hợp lệ', errors: { gia_goc: 'phải là số nguyên' } }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ statusCode: 400, message: 'Dữ liệu không hợp lệ', error: 'Dữ liệu không hợp lệ', errors: { gia_goc: 'phải là số nguyên' } })
  })
  it('không có `errors` → body như cũ (không thêm khoá)', () => {
    const r = run(new BadRequestException(['email phải là email']))
    expect(r.body).toEqual({ statusCode: 400, message: ['email phải là email'], error: 'Bad Request' })
  })
  it('5xx KHÔNG trả `errors` ra ngoài', () => {
    const r = run(new InternalServerErrorException({ message: 'x', errors: { secret: 'y' } }))
    expect(r.status).toBe(500)
    expect(r.body).not.toHaveProperty('errors')
  })
})
