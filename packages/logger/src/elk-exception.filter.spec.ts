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

describe('ElkExceptionFilter → server error reporter', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setServerErrorReporter } = require('./server-error-reporter')
  afterEach(() => setServerErrorReporter(null))
  it('5xx gọi reporter; 4xx thì không', () => {
    const fn = jest.fn()
    setServerErrorReporter(fn)
    run(new BadRequestException('x'))
    expect(fn).not.toHaveBeenCalled()
    run(new Error('boom'))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0][1]).toMatchObject({ status: 500, method: 'POST', url: '/x' })
  })
  it('reporter ném lỗi vẫn trả response bình thường', () => {
    setServerErrorReporter(() => { throw new Error('down') })
    expect(run(new Error('boom')).status).toBe(500)
  })
})

describe('translateTenantError', () => {
  const { translateTenantError } = require('./elk-exception.filter')
  it('maps a missing company context to 404', () => {
    const e = new Error('No company context'); e.name = 'MissingCompanyContextError'
    expect(run(e).status).toBe(404)
  })
  it('maps cross-company trigger errors to 409', () => {
    expect(run(new Error('ERROR: TRINITY_ROUTE_TAKEN: facebook_page 1 is connected to another company')).status).toBe(409)
    expect(run(new Error('TRINITY_EMAIL_TAKEN: a@b.c')).status).toBe(409)
    expect(run(new Error('TRINITY_SINGLE_USER')).status).toBe(409)
  })
  it('leaves other errors alone', () => {
    const e = new Error('boom')
    expect(translateTenantError(e)).toBe(e)
  })
})
