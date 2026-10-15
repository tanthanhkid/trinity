import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateUserDto } from './create-user.dto'

/**
 * DTO `manager_id` validation.
 *
 * Trước fix: 2 @ValidateIf trên cùng property → class-validator gộp condition,
 * @IsInt() bị skip → giá trị "abc" lọt qua DTO validation.
 *
 * Sau fix: 1 @ValidateIf((o) => o.manager_id != null) + @IsInt() → kiểu sai
 * luôn bị reject 400, bất kể manager_id trỏ tới ai (manager_id không ràng buộc theo tên vai trò; hợp lệ CẤU
 * TRÚC — active, không tạo vòng lặp — do service kiểm, KHÔNG phải DTO).
 */
describe('CreateUserDto.manager_id validation', () => {
  const baseDto = {
    email: 'user01@example.vn',
    full_name: 'Nguyễn Văn A',
    password: 'password123',
  }

  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(CreateUserDto, { ...baseDto, ...payload })
    return validate(dto)
  }

  function findManagerIdError(errors: Awaited<ReturnType<typeof validateDto>>) {
    return errors.find((e) => e.property === 'manager_id')
  }

  it('reject string "abc" (kiểu sai phải bị chặn ở DTO)', async () => {
    const errors = await validateDto({ manager_id: 'abc' })
    const managerErr = findManagerIdError(errors)
    expect(managerErr).toBeDefined()
    expect(managerErr?.constraints).toMatchObject({
      isInt: expect.stringContaining('số nguyên'),
    })
  })

  it('pass khi manager_id=null (optional)', async () => {
    const errors = await validateDto({ manager_id: null })
    expect(findManagerIdError(errors)).toBeUndefined()
  })

  it('pass khi manager_id không có (optional)', async () => {
    const errors = await validateDto({})
    expect(findManagerIdError(errors)).toBeUndefined()
  })

  it('pass khi manager_id là integer hợp lệ', async () => {
    const errors = await validateDto({ manager_id: 42 })
    expect(findManagerIdError(errors)).toBeUndefined()
  })

  it('reject float (IsInt yêu cầu integer)', async () => {
    const errors = await validateDto({ manager_id: 1.5 })
    expect(findManagerIdError(errors)).toBeDefined()
  })

  it('reject object', async () => {
    const errors = await validateDto({ manager_id: { id: 1 } })
    expect(findManagerIdError(errors)).toBeDefined()
  })
})
