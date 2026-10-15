import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

/** Danh sách phòng ban mặc định (seed lần đầu) */
export const DEFAULT_DEPARTMENTS: string[] = [
  'Kinh doanh',
  'Kế toán',
  'Hành chính',
  'Marketing',
  'Vận hành',
  'Công nghệ',
  'Khác',
];

export const MAX_DEPARTMENTS = 50;
export const MAX_DEPARTMENT_NAME_LENGTH = 100;

export class UpdateDepartmentsDto {
  @ApiProperty({ type: [String], description: 'Danh sách phòng ban' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_DEPARTMENTS)
  @IsString({ each: true })
  @MaxLength(MAX_DEPARTMENT_NAME_LENGTH, { each: true })
  departments!: string[];
}
