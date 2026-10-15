import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'Kế toán trưởng' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(2, { message: 'Tên vai trò tối thiểu 2 ký tự' })
  @MaxLength(80, { message: 'Tên vai trò tối đa 80 ký tự' })
  name?: string

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null
}
