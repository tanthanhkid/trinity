import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Matches, ValidateNested } from 'class-validator'
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'

// ─── payslip.approved payload ───

export class PayslipApprovedPayloadDto {
  @ApiProperty() @IsNotEmpty() @IsInt()
  payslipId!: number

  @ApiProperty() @IsNotEmpty() @IsInt()
  employeeId!: number

  @ApiProperty({ description: 'FK users.id for notification routing' })
  @IsNotEmpty() @IsInt()
  userId!: number

  @ApiProperty({ example: '2026-03' }) @IsNotEmpty() @IsString()
  month!: string

  @ApiProperty() @IsNotEmpty() @IsInt()
  baseSalary!: number

  @ApiProperty() @IsNotEmpty() @IsInt()
  kpiBonus!: number

  @ApiProperty() @IsNotEmpty() @IsInt()
  totalAmount!: number

  @ApiProperty() @IsNotEmpty() @IsInt()
  approvedBy!: number

  @ApiProperty() @IsNotEmpty() @IsString()
  approvedAt!: string
}

export class PayslipApprovedDto {
  @ApiProperty({ example: 'payslip.approved' })
  @IsNotEmpty() @IsString()
  event!: string

  @ApiProperty({ example: '2026-03-29T10:30:00.000Z' })
  @IsNotEmpty() @IsString()
  timestamp!: string

  @ApiProperty()
  @ValidateNested()
  @Type(() => PayslipApprovedPayloadDto)
  payload!: PayslipApprovedPayloadDto
}

// ─── CRM internal WS emit: notify-ws-emit ───
// Called by CRM service after inserting notification_logs directly (createPendingLogs).
// CRM writes status='sent' to DB but does NOT have access to the WS gateway — so
// it calls this endpoint to have the notification service emit the WebSocket event.

export class WsEmitItemDto {
  @ApiProperty({ description: 'users.id — socket room = user_{id}, WS emit targets this user' })
  @IsNotEmpty() @IsInt()
  recipient_id!: number

  @ApiProperty()
  @IsNotEmpty() @IsString()
  title!: string

  @ApiProperty()
  @IsNotEmpty() @IsString()
  body!: string

  @ApiProperty()
  @IsNotEmpty() @IsString()
  event_type!: string

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  @Matches(/^\/(?![/\\])/, { message: 'action_url phai la duong dan tuong doi bat dau bang /' })
  action_url?: string | null

  @ApiPropertyOptional({ description: 'notification_logs.id khi đã biết (skip DB lookup)' })
  @IsOptional() @IsInt()
  log_id?: number | null
}

export class WsEmitDto {
  @ApiProperty({ type: [WsEmitItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WsEmitItemDto)
  items!: WsEmitItemDto[]
}
