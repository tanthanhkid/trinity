import {
  IsString,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  IsDateString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { POSITION_STATUSES } from './create-position.dto';

export class UpdatePositionDto {
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(50) job_code?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(100) department?: string;
  @IsOptional() @IsString() @MaxLength(100) team?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(150) position_title?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(1) headcount?: number;
  @IsOptional() @IsInt() @Min(1) recruiter_id?: number;
  @IsOptional() @IsDateString() opened_date?: string;
  @IsOptional() @IsDateString() expected_start_date?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(5000) requirements?: string;
  @IsOptional() @IsInt() @Min(0) recruitment_cost?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsIn(POSITION_STATUSES) status?: string;
}
