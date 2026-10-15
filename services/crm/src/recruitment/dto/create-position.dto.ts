import {
  IsString,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  IsDateString,
  MaxLength,
} from 'class-validator';

export const POSITION_STATUSES = ['open', 'closed'] as const;

export class CreatePositionDto {
  @IsString()
  @MaxLength(50)
  job_code!: string;

  // Phòng ban cấu hình động (Cài đặt → Phòng ban) — không whitelist cứng.
  @IsString()
  @MaxLength(100)
  department!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  team?: string;

  @IsString()
  @MaxLength(150)
  position_title!: string;

  @IsInt()
  @Min(1)
  headcount!: number;

  @IsInt()
  @Min(1)
  recruiter_id!: number;

  @IsDateString()
  opened_date!: string;

  @IsOptional()
  @IsDateString()
  expected_start_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  requirements?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  recruitment_cost?: number;

  @IsOptional()
  @IsIn(POSITION_STATUSES)
  status?: string;
}
