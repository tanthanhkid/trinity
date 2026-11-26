import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
