import { IsOptional, IsIn } from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'

export type UnreadCountCategory = 'profile' | 'message'

// cho phep FE hoi so luong "chua doc" theo tung nhom icon
// (Bell = thong bao chung, MessageSquare = tin nhan) thay vi chi 1 tong duy nhat,
// tranh viec FE phai tu suy ra tu list bi LIMIT trang.
export class QueryUnreadCountDto {
  @ApiPropertyOptional({
    enum: ['profile', 'message'],
    description:
      'Loc theo nhom event_type. Bo trong = tong tat ca (thong bao chung + tin nhan).',
  })
  @IsOptional()
  @IsIn(['profile', 'message'])
  category?: UnreadCountCategory
}
