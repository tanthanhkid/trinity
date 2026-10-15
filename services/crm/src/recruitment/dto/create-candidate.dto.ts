import {
  IsString,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  IsDateString,
  MaxLength,
  Matches,
} from 'class-validator';

export const RECRUITMENT_STAGES = [
  'applied',
  'sent_manager',
  'interview',
  'test',
  'offer',
  'hired',
] as const;
export const RECRUITMENT_DECISIONS = ['pending', 'hired', 'rejected'] as const;
export const RECRUITMENT_TYPES = ['internal', 'external'] as const;
export const CANDIDATE_GENDERS = ['M', 'F'] as const;

export class CreateCandidateDto {
  @IsString()
  @MaxLength(150)
  full_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  position?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  @IsOptional()
  @IsIn(RECRUITMENT_STAGES)
  stage?: string;

  @IsOptional()
  @IsIn(RECRUITMENT_DECISIONS)
  decision?: string;

  @IsOptional()
  @IsIn(RECRUITMENT_TYPES)
  recruitment_type?: string;

  @IsOptional()
  @IsDateString()
  applied_date?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsIn(CANDIDATE_GENDERS)
  gender?: string;

  @IsOptional()
  @IsDateString()
  interview_date?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Giờ phỏng vấn phải dạng HH:mm' })
  interview_time?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  recruiter_id?: number;
}
