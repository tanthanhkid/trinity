import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import {
  CreateInsuranceSettingDto, UpdateInsuranceSettingDto,
} from './dto/insurance-setting.dto'

@Injectable()
export class InsuranceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.insuranceSetting.findMany({
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    })
  }

  async create(dto: CreateInsuranceSettingDto, createdBy?: number) {
    await this.assertPeriodValid({
      code: dto.code.trim(),
      from: dto.effective_from,
      to: dto.effective_to ?? null,
      active: dto.is_active ?? true,
    })
    return this.prisma.insuranceSetting.create({
      data: {
        name: dto.name.trim(),
        code: dto.code.trim(),
        employee_rate: dto.employee_rate,
        base_cap: dto.base_cap == null ? null : BigInt(dto.base_cap),
        effective_from: dto.effective_from,
        effective_to: dto.effective_to ?? null,
        is_active: dto.is_active ?? true,
        sort_order: dto.sort_order ?? 0,
        created_by: createdBy ?? null,
      },
    })
  }

  async update(id: number, dto: UpdateInsuranceSettingDto) {
    const cur = await this.getOrThrow(id)
    await this.assertPeriodValid({
      code: dto.code !== undefined ? dto.code.trim() : cur.code,
      from: dto.effective_from ?? cur.effective_from,
      to: dto.effective_to !== undefined ? dto.effective_to ?? null : cur.effective_to,
      active: dto.is_active ?? cur.is_active,
      excludeId: id,
    })
    return this.prisma.insuranceSetting.update({
      where: { id },
      data: this.buildPartial(dto),
    })
  }

  async remove(id: number) {
    await this.getOrThrow(id)
    await this.prisma.insuranceSetting.delete({ where: { id } })
    return { ok: true, id }
  }

  /**
   * `effective_to >= effective_from` và không chồng lấn dòng ĐANG ÁP DỤNG cùng mã —
   * engine cộng mọi dòng khớp tháng nên chồng lấn = trừ bảo hiểm hai lần.
   */
  private async assertPeriodValid(p: {
    code: string
    from: string
    to: string | null
    active: boolean
    excludeId?: number
  }): Promise<void> {
    if (p.to !== null && p.to < p.from) {
      throw new BadRequestException('effective_to phải lớn hơn hoặc bằng effective_from')
    }
    if (!p.active) return
    const others = await this.prisma.insuranceSetting.findMany({
      where: {
        code: p.code,
        is_active: true,
        ...(p.excludeId !== undefined ? { id: { not: p.excludeId } } : {}),
      },
      select: { effective_from: true, effective_to: true },
    })
    const overlap = others.some(
      (o) => o.effective_from <= (p.to ?? '9999-12') && p.from <= (o.effective_to ?? '9999-12'),
    )
    if (overlap) {
      throw new BadRequestException(
        `Mã "${p.code}" đã có cấu hình đang áp dụng chồng lấn khoảng thời gian này (sẽ trừ bảo hiểm hai lần)`,
      )
    }
  }

  private async getOrThrow(id: number) {
    const found = await this.prisma.insuranceSetting.findUnique({ where: { id } })
    if (!found) throw new NotFoundException('Không tìm thấy cấu hình bảo hiểm')
    return found
  }

  private buildPartial(dto: UpdateInsuranceSettingDto): Prisma.InsuranceSettingUpdateInput {
    const data: Prisma.InsuranceSettingUpdateInput = {}
    if (dto.name !== undefined) data.name = dto.name.trim()
    if (dto.code !== undefined) data.code = dto.code.trim()
    if (dto.employee_rate !== undefined) data.employee_rate = dto.employee_rate
    if (dto.base_cap !== undefined) data.base_cap = dto.base_cap == null ? null : BigInt(dto.base_cap)
    if (dto.effective_from !== undefined) data.effective_from = dto.effective_from
    if (dto.effective_to !== undefined) data.effective_to = dto.effective_to ?? null
    if (dto.is_active !== undefined) data.is_active = dto.is_active
    if (dto.sort_order !== undefined) data.sort_order = dto.sort_order
    return data
  }
}
