import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { ResetPasswordDto } from './reset-password.dto'

/**
 * ordering giữa NestJS Guards và Pipes
 *
 * Guards (RolesGuard) chạy TRƯỚC Pipes (ValidationPipe) trong request lifecycle
 * của NestJS. Escalation guard (chặn vai trò không đủ quyền reset người có quyền cao hơn)
 * nằm trong SERVICE — chạy SAU Pipes. Nếu `password` gắn `@IsNotEmpty`
 * ở DTO, ValidationPipe sẽ trả 400 "thiếu password" ngay TẠI PIPE khi body thiếu
 * field này — actor KHÔNG có quyền nhưng bỏ trống password sẽ nhận NHẦM 400 thay
 * vì KHÔNG BAO GIỜ chạy tới escalation guard trong service để nhận đúng 403.
 *
 * DTO PHẢI dùng `@IsOptional()` để pass qua Pipe khi thiếu password, cho request
 * đi tới service — nơi escalation guard chạy TRƯỚC check "bắt buộc nhập password".
 * (Xem `users.service.spec.ts` describe('resetPassword') — test escalation khi KHÔNG
 * truyền password vẫn trả 403.)
 */
describe('ResetPasswordDto validation', () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(ResetPasswordDto, payload)
    return validate(dto)
  }

  it('pass qua ValidationPipe khi KHÔNG truyền password (để service chạy escalation guard trước)', async () => {
    const errors = await validateDto({})
    expect(errors).toHaveLength(0)
  })

  it('pass qua ValidationPipe khi password=undefined tường minh', async () => {
    const errors = await validateDto({ password: undefined })
    expect(errors).toHaveLength(0)
  })

  it('reject khi password CÓ truyền nhưng < 8 ký tự', async () => {
    const errors = await validateDto({ password: 'abc' })
    const err = errors.find((e) => e.property === 'password')
    expect(err).toBeDefined()
    expect(err?.constraints).toHaveProperty('minLength')
  })

  it('reject khi password CÓ truyền nhưng sai kiểu (number)', async () => {
    const errors = await validateDto({ password: 12345678 })
    const err = errors.find((e) => e.property === 'password')
    expect(err).toBeDefined()
  })

  it('pass khi password hợp lệ (≥8 ký tự, string)', async () => {
    const errors = await validateDto({ password: 'ValidPass123' })
    expect(errors).toHaveLength(0)
  })
})
