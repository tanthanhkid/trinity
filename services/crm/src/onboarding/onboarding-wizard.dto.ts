import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, ValidateIf } from 'class-validator';
import { WIZARD_STEPS, type WizardStepKey } from './onboarding-wizard.service';

export class WizardStepDto {
  @ApiProperty({ enum: WIZARD_STEPS })
  @IsIn(WIZARD_STEPS as unknown as string[])
  step!: WizardStepKey;
}

export class WizardConfigDto {
  @ApiPropertyOptional({ description: 'false = tắt hẳn wizard' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: WIZARD_STEPS, isArray: true, description: 'Bước được phép bỏ qua' })
  @IsOptional()
  @IsArray()
  @IsIn(WIZARD_STEPS as unknown as string[], { each: true })
  skippable?: WizardStepKey[];

  @ApiPropertyOptional({ nullable: true, description: 'Miễn wizard cho tài khoản tạo trước thời điểm này (ISO); null = không miễn' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601()
  exempt_before?: string | null;
}
