import { IsOptional, IsInt, Min, Max, IsString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export const POSITION_SORT_FIELDS = [
  'job_code',
  'department',
  'position_title',
  'headcount',
  'opened_date',
  'recruitment_cost',
  'status',
] as const;

export class QueryPositionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number = 25;

  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsIn(POSITION_SORT_FIELDS) sort_by?: string;
  @IsOptional() @IsIn(['asc', 'desc']) sort_dir?: string;
}
