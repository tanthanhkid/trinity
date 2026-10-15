import { IsInt } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class AssignTeamDto {
  @ApiProperty({ description: 'ID của team', example: 1 })
  @IsInt({ message: 'team_id phải là số nguyên' })
  team_id: number
}
