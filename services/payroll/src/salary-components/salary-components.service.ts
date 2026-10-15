import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import {
  CreateSalaryComponentDto,
  UpdateSalaryComponentDto,
} from './dto/salary-component.dto'

@Injectable()
export class SalaryComponentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(componentType?: string) {
    return this.prisma.salaryComponent.findMany({
      where: componentType ? { component_type: componentType } : undefined,
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    })
  }

  async create(dto: CreateSalaryComponentDto, createdBy?: number) {
    try {
      return await this.prisma.salaryComponent.create({
        data: this.buildData(dto, createdBy),
      })
    } catch (err) {
      throw this.mapError(err)
    }
  }

  async update(id: number, dto: UpdateSalaryComponentDto) {
    const existing = await this.getOrThrow(id)
    try {
      return await this.prisma.salaryComponent.update({
        where: { id },
        data: this.buildPartialData(dto, existing.calc_method),
      })
    } catch (err) {
      throw this.mapError(err)
    }
  }

  async remove(id: number) {
    await this.getOrThrow(id)
    await this.prisma.salaryComponent.delete({ where: { id } })
    return { ok: true, id }
  }

  private async getOrThrow(id: number) {
    const found = await this.prisma.salaryComponent.findUnique({ where: { id } })
    if (!found) throw new NotFoundException('Không tìm thấy thành phần lương')
    return found
  }

  // Chuẩn hoá: fixed → bỏ percent_value; percent_base → bỏ fixed_amount.
  private buildData(
    dto: CreateSalaryComponentDto,
    createdBy?: number,
  ): Prisma.SalaryComponentCreateInput {
    const calc = dto.calc_method ?? 'fixed'
    return {
      name: dto.name.trim(),
      code: dto.code.trim(),
      component_type: dto.component_type,
      calc_method: calc,
      fixed_amount: calc === 'fixed' ? BigInt(dto.fixed_amount ?? 0) : null,
      percent_value: calc === 'percent_base' ? (dto.percent_value ?? 0) : null,
      applies_to: dto.applies_to?.trim() || 'all',
      effective_from: dto.effective_from,
      effective_to: dto.effective_to ?? null,
      is_active: dto.is_active ?? true,
      is_taxable: dto.is_taxable ?? true,
      sort_order: dto.sort_order ?? 0,
      description: dto.description?.trim() || null,
      created_by: createdBy ?? null,
    }
  }

  private buildPartialData(
    dto: UpdateSalaryComponentDto,
    existingMethod: string,
  ): Prisma.SalaryComponentUpdateInput {
    const data: Prisma.SalaryComponentUpdateInput = {}
    if (dto.name !== undefined) data.name = dto.name.trim()
    if (dto.code !== undefined) data.code = dto.code.trim()
    if (dto.component_type !== undefined) data.component_type = dto.component_type
    if (dto.applies_to !== undefined) data.applies_to = dto.applies_to.trim() || 'all'
    if (dto.effective_from !== undefined) data.effective_from = dto.effective_from
    if (dto.effective_to !== undefined) data.effective_to = dto.effective_to ?? null
    if (dto.is_active !== undefined) data.is_active = dto.is_active
    if (dto.is_taxable !== undefined) data.is_taxable = dto.is_taxable
    if (dto.sort_order !== undefined) data.sort_order = dto.sort_order
    if (dto.description !== undefined) data.description = dto.description?.trim() || null
    this.applyCalcFields(dto, data, existingMethod)
    return data
  }

  // Đổi calc_method hoặc giá trị → set field tương ứng + LUÔN clear field đối lập.
  // Method hiệu lực = dto.calc_method (nếu gửi) || method hiện tại của record →
  // tránh record vừa fixed_amount vừa percent_value (data inconsistent) khi PATCH qua API thô.
  private applyCalcFields(
    dto: UpdateSalaryComponentDto,
    data: Prisma.SalaryComponentUpdateInput,
    existingMethod: string,
  ): void {
    if (
      dto.calc_method === undefined &&
      dto.fixed_amount === undefined &&
      dto.percent_value === undefined
    ) {
      return
    }
    const method = dto.calc_method ?? existingMethod
    if (method === 'percent_base') {
      data.calc_method = 'percent_base'
      if (dto.percent_value !== undefined) data.percent_value = dto.percent_value
      data.fixed_amount = null
    } else {
      data.calc_method = 'fixed'
      if (dto.fixed_amount !== undefined) data.fixed_amount = BigInt(dto.fixed_amount)
      data.percent_value = null
    }
  }

  private mapError(err: unknown): Error {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException('Mã thành phần lương đã tồn tại')
    }
    return err instanceof Error ? err : new Error('Lỗi không xác định')
  }
}
