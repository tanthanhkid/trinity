import { ArrayMaxSize, ArrayUnique, IsArray, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { MAX_PINNED_MENU_KEYS, isCustomMenuKey, isKnownMenuKey } from '../pinned-menu.constants'

/** Key cố định (KNOWN_MENU_KEYS) hoặc key bảng tuỳ biến đúng định dạng `custom_<key>[__<view>]`. */
@ValidatorConstraint({ name: 'pinnedMenuKey', async: false })
export class PinnedMenuKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && (isKnownMenuKey(value) || isCustomMenuKey(value))
  }
  defaultMessage(): string {
    return 'each value in keys must be a known menu key or a custom table key (custom_<key>)'
  }
}

/**
 * Ghim menu sidebar — thay TOÀN BỘ danh sách đang lưu (không phải
 * thêm/bớt từng phần tử). `[]` là giá trị hợp lệ (user chủ động bỏ ghim hết →
 * FE tự hiện mặc định theo role, xem `pinned_menu_keys` trong schema.prisma).
 */
export class UpdatePinnedMenuDto {
  @ApiProperty({
    type: [String],
    description: `Danh sách key menu đã ghim, tối đa ${MAX_PINNED_MENU_KEYS} — mỗi key thuộc KNOWN_MENU_KEYS hoặc dạng custom_<key> của bảng tuỳ biến.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_PINNED_MENU_KEYS)
  @ArrayUnique()
  @Validate(PinnedMenuKeyConstraint, { each: true })
  keys!: string[]
}
