import { IsString, IsOptional, IsInt, IsIn, IsEmail, Matches, ValidateIf } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'

const VALID_STATUSES = ['active', 'locked'] as const

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'user01@example.com' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string

  @ApiPropertyOptional({ example: 'Nguyễn Văn A' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  full_name?: string

  @ApiPropertyOptional({ example: '0901234567' })
  @IsOptional()
  @IsString()
  @Matches(/^(0|\+84)\d{9}$/, { message: 'Số điện thoại không hợp lệ' })
  // null = xoá số điện thoại (cột nullable)
  phone?: string | null

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  team_id?: number

  @ApiPropertyOptional({
    description:
      'ID người quản lý trực tiếp — BẤT KỲ user đang active nào (RBAC quyền + ' +
      'phạm vi: không còn ràng buộc theo tên vai trò). Không được ' +
      'tạo vòng lặp trong cây quản lý. Null để gỡ manager.',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  manager_id?: number | null

  @ApiPropertyOptional({ enum: VALID_STATUSES })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @IsIn([...VALID_STATUSES], { message: 'Trạng thái không hợp lệ' })
  status?: string

  @ApiPropertyOptional({
    description:
      'ID người quản lý mới nhận cascade managed_users khi khoá user ' +
      '(chỉ áp dụng khi status chuyển sang "locked" và user đang có cấp dưới). ' +
      'Bỏ trống hoặc null → managed_users bị orphan (manager_id=null) + log warning.',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  reassign_to?: number | null
}
