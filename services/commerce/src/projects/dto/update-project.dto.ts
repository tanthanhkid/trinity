import { IsString, IsOptional, IsBoolean, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProjectDto {
  @ApiPropertyOptional({ example: 'Project renamed' })
  // Cột NOT NULL: `null` phải 400 chứ không lọt tới Prisma.
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 'purple' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @ApiPropertyOptional({ example: true })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  is_active?: boolean;
}
