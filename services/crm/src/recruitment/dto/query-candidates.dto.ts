import { IsOptional, IsInt, Min, Max, IsString, IsDateString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export const CANDIDATE_SORT_FIELDS = [
  'full_name', 'applied_date', 'cost', 'stage', 'decision', 'source',
] as const;

export class QueryCandidatesDto {
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
  @IsOptional() @IsString() stage?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() decision?: string;
  @IsOptional() @IsString() recruitment_type?: string;
  @IsOptional() @IsIn(CANDIDATE_SORT_FIELDS) sort_by?: string;
  @IsOptional() @IsIn(['asc', 'desc']) sort_dir?: string;
}

export class QueryRecruitmentStatsDto {
  @IsOptional() @IsDateString() date_from?: string;
  @IsOptional() @IsDateString() date_to?: string;
}
