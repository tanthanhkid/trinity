import { IsOptional, IsString, MinLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class ResetPasswordDto {
  // ⚠️ CỐ Ý @IsOptional() ở tầng DTO/Pipe (KHÔNG @IsNotEmpty) dù password BẮT BUỘC
  // về nghiệp vụ: Guards (RolesGuard) chạy TRƯỚC Pipes trong lifecycle NestJS, nhưng
  // escalation guard (chặn vai trò không đủ quyền reset người có quyền cao hơn)
  // nằm trong SERVICE, tức chạy SAU Pipes. Nếu field này @IsNotEmpty, ValidationPipe
  // sẽ trả 400 "thiếu password" ngay tại Pipe — TRƯỚC KHI service kịp chạy escalation
  // guard — khiến actor KHÔNG có quyền nhưng bỏ trống password nhận nhầm 400 thay vì
  // 403. Enforcement "bắt buộc nhập password" do đó đặt Ở SERVICE (users.service.ts
  // resetPassword(), chạy SAU 2 escalation guard) — @MinLength/@IsString vẫn validate
  // khi CÓ giá trị.
  @ApiProperty({
    description:
      'Mật khẩu mới BẮT BUỘC (tối thiểu 8 ký tự). Admin phải tự nhập — hệ thống KHÔNG còn tự sinh mật khẩu ' +
      'và response KHÔNG trả lại giá trị này (chống lộ plaintext qua network).',
    minLength: 8,
    example: 'MyPassword123',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  password?: string
}
