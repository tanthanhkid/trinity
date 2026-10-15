import { IsOptional, IsInt } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'

/**
 * Body tùy chọn khi khoá (soft delete) user đang có managed_users.
 * - reassign_to: ID quản lý mới cho toàn bộ user đang có manager_id = target.
 *   Nếu không truyền → managed_users bị orphan (manager_id = null) + log warning.
 * - null rõ ràng cũng coi như orphan.
 */
export class LockUserDto {
  @ApiPropertyOptional({
    description:
      'ID người quản lý mới nhận cascade của các nhân viên hiện thuộc user ' +
      'bị khoá. Bỏ trống hoặc null → orphan (manager_id=null).',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  reassign_to?: number | null
}
