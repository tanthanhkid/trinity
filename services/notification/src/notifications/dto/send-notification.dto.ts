import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsISO8601,
  Matches,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export enum NotifChannel {
  PUSH = 'push',
  IN_APP = 'in_app',
  WEBHOOK = 'webhook',
}

export class SendNotificationDto {
  @ApiProperty({ example: 1, description: 'ID nguoi nhan' })
  @IsNotEmpty()
  @IsInt()
  user_id!: number

  @ApiProperty({ enum: NotifChannel, description: 'Kenh gui' })
  @IsNotEmpty()
  @IsEnum(NotifChannel)
  channel!: NotifChannel

  @ApiProperty({ example: 'Cong viec moi can xu ly' })
  @IsNotEmpty()
  @IsString()
  title!: string

  @ApiProperty({ example: 'Deal ABC cua Nguyen Van A da chuyen buoc' })
  @IsNotEmpty()
  @IsString()
  body!: string

  @ApiPropertyOptional({ example: 1, description: 'ID template' })
  @IsOptional()
  @IsInt()
  template_id?: number

  @ApiPropertyOptional({ description: 'Event type cho dedup' })
  @IsOptional()
  @IsString()
  event_type?: string

  @ApiPropertyOptional({ description: 'Entity ID cho dedup' })
  @IsOptional()
  @IsInt()
  entity_id?: number

  @ApiPropertyOptional({ description: 'URL chuyen huong khi click thong bao (phai bat dau bang /)' })
  @IsOptional()
  @IsString()
  @Matches(/^\/(?![/\\])/, { message: 'action_url phai la duong dan tuong doi bat dau bang /' })
  action_url?: string

  @ApiPropertyOptional({ description: 'Thoi gian gui cu the (ISO 8601) — bo qua check gio hanh chinh' })
  @IsOptional()
  @IsISO8601()
  scheduled_at?: string

  @ApiPropertyOptional({ description: 'Metadata bo sung (fcm_token...)' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>
}
