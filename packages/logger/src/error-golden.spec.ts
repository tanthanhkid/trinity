/**
 * Golden phản hồi lỗi của bản Node cho bản Rust (K05, docs/rust/PLAN.md 4.4): chạy ElkExceptionFilter thật trên các
 * loại lỗi hay gặp, so với `server/contracts/errors.golden.json`. Test Rust `trinity-kernel` đọc cùng tệp và phải ra
 * đúng status + body. Đổi filter thì sinh lại: `UPDATE_GOLDEN=1 pnpm --filter @trinity/logger test -- error-golden`.
 */
import * as fs from 'fs'
import * as path from 'path'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  ParseIntPipe,
  type ArgumentsHost,
} from '@nestjs/common'
import type * as winston from 'winston'
import { ElkExceptionFilter } from './elk-exception.filter'

const GOLDEN = path.resolve(__dirname, '../../../server/contracts/errors.golden.json')

function run(exception: unknown, authenticated = false): { status: number; body: unknown } {
  const out = { status: 0, body: {} as unknown }
  const response = { status: (s: number) => { out.status = s; return response }, json: (b: unknown) => { out.body = b } }
  const request = { headers: authenticated ? { authorization: 'Bearer x' } : {}, method: 'GET', url: '/x' }
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as unknown as ArgumentsHost
  const logger = { warn: () => undefined, error: () => undefined } as unknown as winston.Logger
  new ElkExceptionFilter(logger).catch(exception, host)
  return out
}

function named(message: string, name: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}

/** Lỗi Prisma không được bắt ở chỗ gọi (giống hình dạng PrismaClientKnownRequestError, không cần client Prisma). */
function prismaError(code: string): Error {
  return Object.assign(named(`Invalid prisma call: ${code}`, 'PrismaClientKnownRequestError'), { code, meta: { target: ['email'] } })
}

async function parseIntError(): Promise<unknown> {
  try {
    await new ParseIntPipe().transform('abc', { type: 'param', data: 'id' })
  } catch (e) {
    return e
  }
  throw new Error('ParseIntPipe phải ném lỗi')
}

async function cases(): Promise<Record<string, { status: number; body: unknown }>> {
  return {
    bad_request_message: run(new BadRequestException('Số điện thoại không hợp lệ')),
    bad_request_default: run(new BadRequestException()),
    validation_messages: run(new BadRequestException(['email must be an email', 'name should not be empty'])),
    field_errors: run(new BadRequestException({ statusCode: 400, message: 'Dữ liệu không hợp lệ', errors: { gia_goc: 'phải là số nguyên' } })),
    parse_int_pipe: run(await parseIntError()),
    unauthorized_default: run(new UnauthorizedException()),
    unauthorized_message: run(new UnauthorizedException('Phiên đăng nhập đã hết hạn')),
    forbidden_default: run(new ForbiddenException()),
    forbidden_message: run(new ForbiddenException('Bạn không có quyền thực hiện thao tác này')),
    not_found_default: run(new NotFoundException()),
    not_found_message: run(new NotFoundException('Không tìm thấy khách hàng')),
    conflict_message: run(new ConflictException('Mã sản phẩm đã tồn tại')),
    payload_too_large: run(new PayloadTooLargeException('Tệp quá lớn')),
    http_exception_string: run(new HttpException('Quá nhiều yêu cầu, thử lại sau', HttpStatus.TOO_MANY_REQUESTS)),
    http_exception_object: run(new HttpException({ message: 'Tính năng chưa bật', error: 'Feature Disabled' }, HttpStatus.FORBIDDEN)),
    internal_plain_error: run(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    internal_http_exception: run(new InternalServerErrorException({ message: 'Không tạo được phiếu', errors: { secret: 'y' } })),
    service_unavailable: run(new ServiceUnavailableException('Máy chủ đang bảo trì')),
    prisma_p2002_uncaught: run(prismaError('P2002')),
    prisma_p2025_uncaught: run(prismaError('P2025')),
    tenant_email_taken: run(new Error('ERROR: TRINITY_EMAIL_TAKEN: a@b.c')),
    tenant_route_taken: run(new Error('ERROR: TRINITY_ROUTE_TAKEN: facebook_page 1 is connected to another company')),
    missing_company_public: run(named('No company context', 'MissingCompanyContextError')),
    missing_company_signed_in: run(named('No company context', 'MissingCompanyContextError'), true),
  }
}

describe('golden lỗi cho bản Rust', () => {
  it('ElkExceptionFilter khớp server/contracts/errors.golden.json', async () => {
    const got = await cases()
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n')
    expect(got).toEqual(JSON.parse(fs.readFileSync(GOLDEN, 'utf8')))
  })
})
