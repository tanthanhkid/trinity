import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsIn, IsInt, Min, ValidateNested } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { LOGIN_WIFI_CHECK_SCOPE_TYPES, LoginWifiCheckScopeType } from '../login-wifi-check-targets.helper'

// 1 dòng cấu hình "áp dụng" cho kiểm tra wifi khi đăng nhập.
export class LoginWifiCheckTargetItemDto {
  @ApiProperty({
    enum: LOGIN_WIFI_CHECK_SCOPE_TYPES,
    description: 'department = 1 quản lý phòng (subtree 2 cấp) | team = 1 quản lý nhóm (subtree 1 cấp) | user = 1 nhân viên bất kỳ',
  })
  @IsIn(LOGIN_WIFI_CHECK_SCOPE_TYPES, { message: 'scope_type không hợp lệ' })
  scope_type: LoginWifiCheckScopeType

  @ApiProperty({ description: 'user id của quản lý phòng/quản lý nhóm/nhân viên tuỳ scope_type' })
  @IsInt({ message: 'target_user_id phải là số nguyên' })
  @Min(1, { message: 'target_user_id không hợp lệ' })
  target_user_id: number
}

// Trần 1000 dòng — đủ rộng cho MỌI tổ hợp phòng/team/nhân viên nhưng vẫn chặn payload bất thường.
const MAX_TARGET_ITEMS = 1000

export class ReplaceLoginWifiCheckTargetsDto {
  @ApiProperty({ type: [LoginWifiCheckTargetItemDto], description: 'Mảng RỖNG = xoá sạch, không ai bị áp dụng' })
  @IsArray({ message: 'items phải là mảng' })
  @ArrayMaxSize(MAX_TARGET_ITEMS, { message: `Tối đa ${MAX_TARGET_ITEMS} dòng cấu hình` })
  @ValidateNested({ each: true })
  @Type(() => LoginWifiCheckTargetItemDto)
  items: LoginWifiCheckTargetItemDto[]
}
