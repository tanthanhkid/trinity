import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { INT4_MAX } from '../../common/validation/int4';
import { DISCOUNT_TYPES, MAX_MONEY, MAX_QTY, ORDER_TYPES, PAYMENT_METHODS } from '../pos.constants';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class OrderItemInputDto {
  @ApiProperty() @IsInt() @Min(1) @Max(INT4_MAX) product_id!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(MAX_QTY) quantity!: number;
  @ApiPropertyOptional({ type: [Number], description: 'Id tuỳ chọn (size/đá/đường); BE tra giá.' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsInt({ each: true }) @Min(1, { each: true }) @Max(INT4_MAX, { each: true })
  modifier_ids?: number[];
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(255) note?: string;
}

/** Trường chung của tạo/sửa đơn. KHÔNG có `price`/`total`: BE tự tính. */
export class OrderFieldsDto {
  @ApiPropertyOptional({ description: 'Bàn; null = không gán bàn.' })
  @IsOptional() @IsInt() @Min(1) @Max(INT4_MAX) table_id?: number | null;
  @ApiPropertyOptional({ enum: ORDER_TYPES }) @IsOptional() @IsIn(ORDER_TYPES) order_type?: (typeof ORDER_TYPES)[number];
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ enum: DISCOUNT_TYPES }) @IsOptional() @IsIn(DISCOUNT_TYPES) discount_type?: (typeof DISCOUNT_TYPES)[number];
  @ApiPropertyOptional({ description: 'percent: 0-100; amount: VND.' })
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(0) @Max(MAX_MONEY) discount_value?: number;
}

export class CreateOrderDto extends OrderFieldsDto {
  @ApiProperty({ type: [OrderItemInputDto] })
  @IsArray() @ArrayMinSize(1, { message: 'Đơn cần ít nhất 1 món' }) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

export class UpdateOrderDto extends OrderFieldsDto {
  @ApiPropertyOptional({ type: [OrderItemInputDto], description: 'Có gửi = THAY TOÀN BỘ dòng món.' })
  @ValidateIf((_o, v) => v !== undefined) @IsArray() @ArrayMinSize(1, { message: 'Đơn cần ít nhất 1 món' }) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
}

export class PaymentInputDto {
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) method!: (typeof PAYMENT_METHODS)[number];
  @ApiProperty({ description: 'VND tính vào đơn.' }) @IsInt() @Min(1) @Max(MAX_MONEY) amount!: number;
  @ApiPropertyOptional({ description: 'Tiền khách đưa (chỉ tiền mặt).' })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MONEY) tendered?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(100) reference?: string;
}

export class PayOrderDto {
  @ApiProperty({ type: [PaymentInputDto] })
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => PaymentInputDto)
  payments!: PaymentInputDto[];
}

export class VoidOrderDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3, { message: 'Nhập lý do huỷ (≥ 3 ký tự)' }) @MaxLength(500)
  reason!: string;
}

export class ListOrdersQueryDto {
  @IsOptional() @IsIn(['open', 'paid', 'void']) status?: 'open' | 'paid' | 'void';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(INT4_MAX) table_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(INT4_MAX) shift_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(INT4_MAX) cursor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class QrQueryDto {
  @ApiPropertyOptional({ description: 'Số tiền dòng chuyển khoản (chia thanh toán); mặc định = tổng đơn, tối đa = tổng đơn.' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_MONEY) amount?: number;
}
