import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength,
  ValidateIf,
} from 'class-validator';
import { INT4_MAX } from '../../common/validation/int4';
import { MAX_MONEY } from '../pos.constants';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class OpenShiftDto {
  @IsInt() @Min(0) @Max(MAX_MONEY) opening_cash!: number;
}

export class CloseShiftDto {
  @IsInt() @Min(0) @Max(MAX_MONEY) closing_cash_counted!: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class ListShiftsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(INT4_MAX) cursor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class DailyReportQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date phải dạng YYYY-MM-DD' }) date?: string;
}

export class UpdateSettingsDto {
  @ValidateIf((_o, v) => v !== undefined) @Transform(trim) @IsString() @MinLength(1) @MaxLength(255) store_name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(32) phone?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) receipt_footer?: string | null;
  @IsOptional() @Matches(/^\d{6}$/, { message: 'BIN ngân hàng gồm 6 chữ số' }) bank_bin?: string | null;
  @IsOptional() @Matches(/^\d{4,19}$/, { message: 'Số tài khoản gồm 4–19 chữ số' }) bank_account_no?: string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(255) bank_account_name?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsInt({ each: true }) @Min(1, { each: true }) @Max(INT4_MAX, { each: true })
  menu_category_ids?: number[];
}

export class MenuQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(INT4_MAX) category_id?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
}

export class CreateAreaDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(9999) sort_order?: number;
}
export class UpdateAreaDto {
  @ValidateIf((_o, v) => v !== undefined) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(9999) sort_order?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_active?: boolean;
}

export class CreateTableDto {
  @IsInt() @Min(1) @Max(INT4_MAX) area_id!: number;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(50) name!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(9999) sort_order?: number;
}
export class UpdateTableDto {
  @ValidateIf((_o, v) => v !== undefined) @Transform(trim) @IsString() @MinLength(1) @MaxLength(50) name?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(9999) sort_order?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_active?: boolean;
}

export class CreateModifierDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) group_name!: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsInt() @Min(-MAX_MONEY) @Max(MAX_MONEY) price_delta?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(9999) sort_order?: number;
}
export class UpdateModifierDto {
  @ValidateIf((_o, v) => v !== undefined) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) group_name?: string;
  @ValidateIf((_o, v) => v !== undefined) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsInt() @Min(-MAX_MONEY) @Max(MAX_MONEY) price_delta?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(9999) sort_order?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() is_active?: boolean;
}
export class ListModifiersQueryDto {
  @IsOptional() @Transform(bool) @IsBoolean() include_inactive?: boolean;
}
