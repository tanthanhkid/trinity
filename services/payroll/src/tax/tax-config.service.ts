import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import {
  CreateTaxBracketDto, UpdateTaxBracketDto,
  CreateTaxSettingDto, UpdateTaxSettingDto,
} from './dto/tax-config.dto'

/** Cận trên phải lớn hơn cận dưới (bậc cao nhất để trống cận trên). */
function assertBracketRange(lower: number, upper: number | null | undefined): void {
  if (upper != null && upper <= lower) throw new BadRequestException('Cận trên phải lớn hơn cận dưới')
}

@Injectable()
export class TaxConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig() {
    const [brackets, settings] = await Promise.all([
      this.prisma.taxBracket.findMany({ orderBy: [{ effective_from: 'desc' }, { bracket_order: 'asc' }] }),
      this.prisma.payrollTaxSetting.findMany({ orderBy: { effective_from: 'desc' } }),
    ])
    return { brackets, settings }
  }

  // --- Brackets ---
  createBracket(dto: CreateTaxBracketDto, createdBy?: number) {
    assertBracketRange(dto.lower_bound, dto.upper_bound)
    return this.prisma.taxBracket.create({
      data: {
        bracket_order: dto.bracket_order,
        lower_bound: BigInt(dto.lower_bound),
        upper_bound: dto.upper_bound == null ? null : BigInt(dto.upper_bound),
        rate: dto.rate,
        effective_from: dto.effective_from,
        effective_to: dto.effective_to ?? null,
        is_active: dto.is_active ?? true,
        created_by: createdBy ?? null,
      },
    })
  }

  async updateBracket(id: number, dto: UpdateTaxBracketDto) {
    const cur = await this.findBracket(id)
    assertBracketRange(
      dto.lower_bound ?? Number(cur.lower_bound),
      dto.upper_bound !== undefined ? dto.upper_bound : cur.upper_bound === null ? null : Number(cur.upper_bound),
    )
    const data: Prisma.TaxBracketUpdateInput = {}
    if (dto.bracket_order !== undefined) data.bracket_order = dto.bracket_order
    if (dto.lower_bound !== undefined) data.lower_bound = BigInt(dto.lower_bound)
    if (dto.upper_bound !== undefined) data.upper_bound = dto.upper_bound == null ? null : BigInt(dto.upper_bound)
    if (dto.rate !== undefined) data.rate = dto.rate
    if (dto.effective_from !== undefined) data.effective_from = dto.effective_from
    if (dto.effective_to !== undefined) data.effective_to = dto.effective_to ?? null
    if (dto.is_active !== undefined) data.is_active = dto.is_active
    return this.prisma.taxBracket.update({ where: { id }, data })
  }

  async removeBracket(id: number) {
    await this.findBracket(id)
    await this.prisma.taxBracket.delete({ where: { id } })
    return { ok: true, id }
  }

  // --- Settings (giảm trừ gia cảnh) ---
  createSetting(dto: CreateTaxSettingDto, createdBy?: number) {
    return this.prisma.payrollTaxSetting.create({
      data: {
        personal_deduction: BigInt(dto.personal_deduction),
        dependent_deduction: BigInt(dto.dependent_deduction),
        effective_from: dto.effective_from,
        effective_to: dto.effective_to ?? null,
        is_active: dto.is_active ?? true,
        created_by: createdBy ?? null,
      },
    })
  }

  async updateSetting(id: number, dto: UpdateTaxSettingDto) {
    await this.findSetting(id)
    const data: Prisma.PayrollTaxSettingUpdateInput = {}
    if (dto.personal_deduction !== undefined) data.personal_deduction = BigInt(dto.personal_deduction)
    if (dto.dependent_deduction !== undefined) data.dependent_deduction = BigInt(dto.dependent_deduction)
    if (dto.effective_from !== undefined) data.effective_from = dto.effective_from
    if (dto.effective_to !== undefined) data.effective_to = dto.effective_to ?? null
    if (dto.is_active !== undefined) data.is_active = dto.is_active
    return this.prisma.payrollTaxSetting.update({ where: { id }, data })
  }

  private async findBracket(id: number) {
    const b = await this.prisma.taxBracket.findUnique({ where: { id } })
    if (!b) throw new NotFoundException('Không tìm thấy bậc thuế')
    return b
  }

  private async findSetting(id: number) {
    const s = await this.prisma.payrollTaxSetting.findUnique({ where: { id } })
    if (!s) throw new NotFoundException('Không tìm thấy cấu hình giảm trừ')
    return s
  }
}
