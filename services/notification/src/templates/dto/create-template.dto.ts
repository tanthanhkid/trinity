import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
} from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'

export enum NotificationChannel {
  PUSH = 'push',
  IN_APP = 'in_app',
  WEBHOOK = 'webhook',
}

export interface RecipientsRule {
  roles?: string[]
  fields?: string[]
}

export class CreateTemplateDto {
  @ApiProperty({ example: 'lead_stage_changed', description: 'Ten template' })
  @IsNotEmpty()
  @IsString()
  name!: string

  @ApiProperty({
    example: 'deal.stage.changed',
    description: 'Loai event trigger template',
  })
  @IsNotEmpty()
  @IsString()
  event_type!: string

  @ApiProperty({
    enum: NotificationChannel,
    description: 'Kenh gui thong bao',
  })
  @IsNotEmpty()
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel

  @ApiPropertyOptional({
    example: 'Deal {{contactName}} chuyen buoc',
    description: 'Tieu de',
  })
  @IsOptional()
  @IsString()
  subject?: string

  @ApiProperty({
    example:
      'Deal {{contactName}} da chuyen tu buoc {{fromStage}} sang buoc {{toStage}}',
    description: 'Noi dung template (Handlebars syntax)',
  })
  @IsNotEmpty()
  @IsString()
  body!: string

  @ApiPropertyOptional({
    example: { fields: ['assignedTo'] },
    description: 'Reserved: stored with the template but not yet used to route recipients',
  })
  @IsOptional()
  @IsObject()
  recipients_rule?: RecipientsRule

  @ApiPropertyOptional({
    example: true,
    description: 'Trang thai hoat dong',
  })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean
}
