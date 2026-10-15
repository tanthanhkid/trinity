import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export class CreateRoleDto {
  @ApiProperty({ example: 'Kế toán', description: 'Tên vai trò (duy nhất, không phân biệt hoa/thường)' })
  @IsString()
  @MinLength(2, { message: 'Tên vai trò tối thiểu 2 ký tự' })
  @MaxLength(80, { message: 'Tên vai trò tối đa 80 ký tự' })
  name: string

  @ApiPropertyOptional({ example: 'Xem và xuất báo cáo công nợ' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string

  @ApiProperty({
    example: { 'contacts.view': 'team', 'contacts.export': null },
    description:
      'Quyền của vai trò: khoá = mã quyền trong danh mục (GET /rbac/catalog). Quyền scoped → ' +
      'own|team|subtree|all; quyền không scoped → null (hoặc true). Khoá vắng mặt = không cấp.',
  })
  @IsObject({ message: 'grants phải là object' })
  grants: Record<string, unknown>
}
