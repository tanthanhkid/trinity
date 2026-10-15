import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PAYMENT_SOURCE_TYPES } from './payments.service';

export class SaveSepayDto {
  @ApiProperty({ example: '0123456789', description: 'Số tài khoản nhận tiền đã liên kết với SePay' })
  @IsString()
  @MaxLength(40)
  account_number!: string;

  @ApiProperty({ example: 'MBBank', description: 'Tên ngân hàng theo SePay/VietQR (MBBank, Vietcombank, ACB, TPBank…)' })
  @IsString()
  @MaxLength(40)
  bank!: string;

  @ApiPropertyOptional({ example: 'CONG TY ABC' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  account_name?: string;

  @ApiPropertyOptional({ example: 'TRN', description: 'Tiền tố mã thanh toán (2–5 chữ cái)' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  code_prefix?: string;

  @ApiPropertyOptional({ description: 'true = sinh khoá webhook mới (khoá cũ hết hiệu lực)' })
  @IsOptional()
  @IsBoolean()
  rotate_key?: boolean;
}

export class CreatePaymentDto {
  @ApiProperty({ example: 150000, description: 'Số tiền (VND)' })
  @IsNumber()
  @Min(1000)
  @Max(10_000_000_000)
  amount!: number;

  @ApiPropertyOptional({ example: 'Học phí tháng 11 — bé An' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ enum: PAYMENT_SOURCE_TYPES })
  @IsOptional()
  @IsIn(PAYMENT_SOURCE_TYPES as unknown as string[])
  source_type?: (typeof PAYMENT_SOURCE_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  source_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  contact_id?: number;

  @ApiPropertyOptional({ description: 'Hạn thanh toán (giờ), bỏ trống = không hạn' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(24 * 90)
  expires_in_hours?: number;
}

export class SaveVnpayDto {
  @ApiProperty({ description: 'Mã website (vnp_TmnCode)' })
  @IsString()
  @MaxLength(20)
  tmn_code!: string;

  @ApiPropertyOptional({ description: 'Chuỗi bí mật (vnp_HashSecret); để trống khi sửa = giữ khoá cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hash_secret?: string;

  @ApiPropertyOptional({ description: 'true = môi trường thử (sandbox.vnpayment.vn)' })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
}

export class SaveMomoDto {
  @ApiProperty({ description: 'Partner code' })
  @IsString()
  @MaxLength(40)
  partner_code!: string;

  @ApiPropertyOptional({ description: 'Access key; để trống khi sửa = giữ khoá cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  access_key?: string;

  @ApiPropertyOptional({ description: 'Secret key; để trống khi sửa = giữ khoá cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  secret_key?: string;

  @ApiPropertyOptional({ description: 'true = môi trường thử (test-payment.momo.vn)' })
  @IsOptional()
  @IsBoolean()
  sandbox?: boolean;
}

export class SaveKiotVietDto {
  @ApiProperty({ description: 'Tên gian hàng (phần trước .kiotviet.vn)', example: 'cuahangabc' })
  @IsString()
  @MaxLength(60)
  retailer!: string;

  @ApiProperty({ description: 'Client ID (Thiết lập › Thiết lập kết nối API)' })
  @IsString()
  @MaxLength(80)
  client_id!: string;

  @ApiPropertyOptional({ description: 'Mã bảo mật; để trống khi sửa = giữ khoá cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  client_secret?: string;
}

export class SaveSapoDto {
  @ApiProperty({ description: 'Tên cửa hàng (phần trước .mysapo.net)', example: 'cuahangabc' })
  @IsString()
  @MaxLength(80)
  store!: string;

  @ApiProperty({ description: 'API key của ứng dụng riêng (Private app)' })
  @IsString()
  @MaxLength(80)
  api_key!: string;

  @ApiPropertyOptional({ description: 'Mật khẩu/secret của ứng dụng riêng; để trống khi sửa = giữ khoá cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  secret?: string;
}

export class SaveMisaDto {
  @ApiProperty({ description: 'Mã công ty (org_company_code) trong AMIS Kế toán' })
  @IsString()
  @MaxLength(60)
  company_code!: string;

  @ApiPropertyOptional({ description: 'Mã kết nối (access_code) lấy ở AMIS Kế toán › Thiết lập › Kết nối ứng dụng; để trống khi sửa = giữ mã cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  access_code?: string;
}

export class SaveWooDto {
  @ApiProperty({ description: 'Địa chỉ cửa hàng (https://…)', example: 'https://shop.example.com' })
  @IsString()
  @MaxLength(200)
  url!: string;

  @ApiProperty({ description: 'Consumer key (ck_…)' })
  @IsString()
  @MaxLength(80)
  consumer_key!: string;

  @ApiPropertyOptional({ description: 'Consumer secret (cs_…); để trống khi sửa = giữ khoá cũ' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  consumer_secret?: string;
}
