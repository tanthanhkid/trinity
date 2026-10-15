import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsString,
  Matches,
  IsOptional,
  IsArray,
  IsInt,
  ArrayMaxSize,
} from 'class-validator'

// Body cho POST /payslips/excel-list — xuất Excel danh sách lương theo ĐÚNG thứ tự màn hình.
// `ordered_ids` là danh sách id phiếu lương đang hiển thị (đã lọc + sắp xếp client-side),
// theo thứ tự xuất hiện trên bảng → file Excel khớp 100% giao diện. Bỏ trống → BE tự sắp
// theo team (hành vi cũ, tương thích ngược với GET /payslips/excel-list).
export class ListExcelPayslipsDto {
  @ApiProperty({ description: 'Tháng (YYYY-MM)', example: '2026-03' })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month phải có định dạng YYYY-MM',
  })
  month!: string

  @ApiPropertyOptional({
    description: 'Danh sách id phiếu theo đúng thứ tự đang hiển thị trên màn hình',
    type: [Number],
    example: [12, 7, 31],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @IsInt({ each: true })
  ordered_ids?: number[]
}
