import { ArrayMaxSize, ArrayUnique, IsArray, IsIn } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { KNOWN_MENU_KEYS, MAX_PINNED_MENU_KEYS } from '../pinned-menu.constants'

/**
 * Ghim menu sidebar — thay TOÀN BỘ danh sách đang lưu (không phải
 * thêm/bớt từng phần tử). `[]` là giá trị hợp lệ (user chủ động bỏ ghim hết →
 * FE tự hiện mặc định theo role, xem `pinned_menu_keys` trong schema.prisma).
 */
export class UpdatePinnedMenuDto {
  @ApiProperty({
    type: [String],
    description: `Danh sách key menu đã ghim, tối đa ${MAX_PINNED_MENU_KEYS} — mỗi key phải thuộc KNOWN_MENU_KEYS.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_PINNED_MENU_KEYS)
  @ArrayUnique()
  @IsIn(KNOWN_MENU_KEYS, { each: true })
  keys!: string[]
}
