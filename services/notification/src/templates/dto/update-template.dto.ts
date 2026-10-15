import {
  IsString,
  IsEnum,
  IsOptional,
  ValidateIf,
  IsBoolean,
  IsObject,
} from 'class-validator'
import { ApiPropertyOptional } from '@nestjs/swagger'
import { NotificationChannel, RecipientsRule } from './create-template.dto'

export class UpdateTemplateDto {
  @ApiPropertyOptional({ example: 'lead_stage_changed' })
  @ValidateIf((_o, v) => v !== undefined) // cột NOT NULL: null phải 400
  @IsString()
  name?: string

  @ApiPropertyOptional({ example: 'deal.stage.changed' })
  @ValidateIf((_o, v) => v !== undefined) // cột NOT NULL: null phải 400
  @IsString()
  event_type?: string

  @ApiPropertyOptional({ enum: NotificationChannel })
  @ValidateIf((_o, v) => v !== undefined) // cột NOT NULL: null phải 400
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel

  @ApiPropertyOptional({ example: 'Deal {{contactName}} chuyen buoc' })
  @IsOptional()
  @IsString()
  subject?: string

  @ApiPropertyOptional({
    example: 'Deal {{contactName}} da chuyen sang buoc {{toStage}}',
  })
  @ValidateIf((_o, v) => v !== undefined) // cột NOT NULL: null phải 400
  @IsString()
  body?: string

  @ApiPropertyOptional({
    example: { fields: ['assignedTo'] },
    description: 'Reserved: stored with the template but not yet used to route recipients',
  })
  @IsOptional()
  @IsObject()
  recipients_rule?: RecipientsRule

  @ApiPropertyOptional({ example: true })
  @ValidateIf((_o, v) => v !== undefined) // cột NOT NULL: null phải 400
  @IsBoolean()
  is_active?: boolean
}
