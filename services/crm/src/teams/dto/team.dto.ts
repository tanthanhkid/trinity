import {
  IsString,
  IsOptional,
  IsInt,
  MaxLength,
  ValidateIf,
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
  Matches,
} from 'class-validator';

// Mã màu hex hợp lệ (#rgb hoặc #rrggbb).
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class CreateTeamDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  // Phòng ban (nhãn từ Cài đặt → Phòng ban). 1 phòng ban có nhiều team.
  @IsOptional()
  @ValidateIf((o: CreateTeamDto) => o.department !== null)
  @IsString()
  @MaxLength(100)
  department?: string | null;

  @IsOptional()
  @ValidateIf((o: CreateTeamDto) => o.description !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  // Trưởng nhóm phụ trách (users.id, role=team_lead). 1 trưởng nhóm = 1 team.
  @IsOptional()
  @ValidateIf((o: CreateTeamDto) => o.team_lead_id !== null)
  @IsInt()
  team_lead_id?: number | null;

  // Màu nhận diện team (hex "#3b82f6"). Rỗng/null = FE fallback palette.
  @IsOptional()
  @ValidateIf((o: CreateTeamDto) => o.color != null)
  @IsString()
  @MaxLength(20)
  @Matches(HEX_COLOR_RE, { message: 'Màu phải là mã hex hợp lệ (vd: #f59e0b)' })
  color?: string | null;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @ValidateIf((o: UpdateTeamDto) => o.department !== null)
  @IsString()
  @MaxLength(100)
  department?: string | null;

  @IsOptional()
  @ValidateIf((o: UpdateTeamDto) => o.description !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @ValidateIf((o: UpdateTeamDto) => o.team_lead_id !== null)
  @IsInt()
  team_lead_id?: number | null;

  // Màu nhận diện team (hex "#3b82f6"). Rỗng/null = FE fallback palette.
  @IsOptional()
  @ValidateIf((o: UpdateTeamDto) => o.color != null)
  @IsString()
  @MaxLength(20)
  @Matches(HEX_COLOR_RE, { message: 'Màu phải là mã hex hợp lệ (vd: #f59e0b)' })
  color?: string | null;
}

// Gán/bỏ thành viên team (theo users.id). Người phụ trách team là NHÃN, role bất kỳ.
export class TeamMembersDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  user_ids!: number[];
}
