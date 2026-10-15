import { IsObject } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class SetGrantsDto {
  @ApiProperty({
    example: { 'contacts.view': 'subtree', 'contacts.export': null },
    description: 'THAY TOÀN BỘ quyền của vai trò (không merge). Xem CreateRoleDto.grants.',
  })
  @IsObject({ message: 'grants phải là object' })
  grants: Record<string, unknown>
}
