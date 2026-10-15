import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
} from 'class-validator'
import { Type } from 'class-transformer'

export const API_KEY_SCOPES = [
  'auth:login',
  'contacts:create',
  'deals:create',
  'tasks:create',
] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export class CreateApiKeyDto {
  @ApiProperty({
    example: 'Landing page',
    description: 'Tên khoá (mô tả dùng ở đâu). 1-120 ký tự.',
  })
  @IsString()
  @Length(1, 120, { message: 'Tên khoá 1-120 ký tự' })
  name!: string

  @ApiProperty({
    example: ['auth:login', 'contacts:create'],
    description: 'Phạm vi cho phép. auth:login | contacts:create',
    enum: API_KEY_SCOPES,
    isArray: true,
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'Phải chọn ít nhất 1 phạm vi' })
  @IsIn(API_KEY_SCOPES, { each: true, message: 'Phạm vi không hợp lệ' })
  scopes!: ApiKeyScope[]

  @ApiProperty({
    example: 12,
    description:
      'User gán (assigned_to) cho contact tạo qua API key. Phải là user active.',
  })
  @Type(() => Number)
  @IsInt({ message: 'owner_user_id phải là số nguyên' })
  owner_user_id!: number

  @ApiPropertyOptional({
    example: '2027-01-01T00:00:00Z',
    description: 'Ngày hết hạn (ISO). Null = không hết hạn.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'expires_at không hợp lệ' })
  expires_at?: string
}
