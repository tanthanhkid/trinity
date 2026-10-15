import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class UpdateBriefingConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() morning_enabled?: boolean;
  @IsOptional() @IsBoolean() evening_enabled?: boolean;
  @IsOptional() @Matches(HHMM, { message: 'Giờ phải dạng HH:mm' }) morning_time?: string;
  @IsOptional() @Matches(HHMM, { message: 'Giờ phải dạng HH:mm' }) evening_time?: string;
  @IsOptional() @IsBoolean() in_app?: boolean;
}

export class SlotQueryDto {
  @IsOptional() @IsIn(['morning', 'evening']) slot?: 'morning' | 'evening';
}
