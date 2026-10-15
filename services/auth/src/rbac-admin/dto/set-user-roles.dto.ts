import { ArrayMaxSize, ArrayUnique, IsArray, IsInt } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class SetUserRolesDto {
  @ApiProperty({ example: [2, 5], description: 'THAY TOÀN BỘ vai trò của người dùng; [] = gỡ hết.' })
  @IsArray({ message: 'roleIds phải là mảng' })
  @ArrayMaxSize(50, { message: 'Tối đa 50 vai trò' })
  @ArrayUnique({ message: 'roleIds bị trùng' })
  @IsInt({ each: true, message: 'roleIds phải là số nguyên' })
  roleIds: number[]
}
