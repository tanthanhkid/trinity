import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator'

export enum ApprovalAction {
  APPROVE = 'approve',
  REJECT = 'reject',
}

export class ApprovePayslipDto {
  @ApiProperty({
    enum: ApprovalAction,
    description: 'Hành động: duyệt hoặc từ chối',
  })
  @IsEnum(ApprovalAction, {
    message: 'action phải là "approve" hoặc "reject"',
  })
  action!: ApprovalAction

  @ApiPropertyOptional({ description: 'Ghi chú duyệt/từ chối', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string
}
