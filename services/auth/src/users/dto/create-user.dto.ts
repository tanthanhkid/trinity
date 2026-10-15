import {
  IsEmail,
  IsString,
  MinLength,
  IsOptional,
  IsInt,
  ValidateIf,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class CreateUserDto {
  @ApiProperty({ example: 'user01@example.com' })
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email: string

  @ApiProperty({ example: 'Nguyễn Văn A' })
  @IsString()
  full_name: string

  @ApiProperty({ description: 'Mật khẩu (tối thiểu 8 ký tự)' })
  @IsString()
  @MinLength(8, { message: 'Mật khẩu tối thiểu 8 ký tự' })
  password: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  team_id?: number

  @ApiPropertyOptional({
    description:
      'ID người quản lý trực tiếp. Có thể là BẤT KỲ user đang active nào ' +
      '(không ràng buộc theo tên vai trò). Null để không có quản lý.',
    nullable: true,
  })
  /**
   * DTO chỉ validate KIỂU dữ liệu: nếu `manager_id` được truyền (khác null/
   * undefined) thì BẮT BUỘC phải là integer. Rule nghiệp vụ (manager tồn tại,
   * đang active, không tạo vòng lặp) do service đảm nhận
   * (`users.service.ts` `assertManagerValid`/`assertNoManagerCycle`).
   *
   * Lưu ý: 2 @ValidateIf trên cùng property bị class-validator gộp condition
   * thành ONE evaluation, khiến @IsInt() bị skip. Giữ MỘT @ValidateIf duy nhất
   * bao trọn rule type-check.
   */
  @ValidateIf((o) => o.manager_id != null)
  @IsInt({ message: 'manager_id phải là số nguyên' })
  manager_id?: number | null
}
