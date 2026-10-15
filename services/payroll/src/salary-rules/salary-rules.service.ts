import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import { CreateSalaryRuleDto } from './dto/create-rule.dto'
import { UpdateSalaryRuleDto } from './dto/update-rule.dto'
import { validateFormula } from './formula-evaluator'

@Injectable()
export class SalaryRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.salaryRule.findMany({
      select: {
        id: true,
        position: true,
        name: true,
        description: true,
        details: {
          select: {
            id: true,
            component: true,
            amount: true,
            formula: true,
            params: true,
            order: true,
          },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    })
  }

  async findByPosition(position: string) {
    return this.prisma.salaryRule.findMany({
      where: { position },
      select: {
        id: true,
        position: true,
        name: true,
        description: true,
        details: {
          select: {
            id: true,
            component: true,
            amount: true,
            formula: true,
            params: true,
            order: true,
          },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    })
  }

  async findById(id: number) {
    const rule = await this.prisma.salaryRule.findUnique({
      where: { id },
      select: {
        id: true,
        position: true,
        name: true,
        description: true,
        details: {
          select: {
            id: true,
            component: true,
            amount: true,
            formula: true,
            params: true,
            order: true,
          },
          orderBy: { order: 'asc' },
        },
      },
    })

    if (!rule) {
      throw new NotFoundException(`Bảng lương #${id} không tồn tại`)
    }

    return rule
  }

  async create(dto: CreateSalaryRuleDto) {
    // Validate all formulas before persisting
    for (const detail of dto.details) {
      if (detail.formula && !validateFormula(detail.formula)) {
        throw new BadRequestException(
          `Công thức không hợp lệ cho component "${detail.component}": ${detail.formula}`,
        )
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.salaryRule.create({
        data: {
          position: dto.position,
          name: dto.name,
          description: dto.description,
        },
      })

      const details = await Promise.all(
        dto.details.map((d, index) =>
          tx.salaryRuleDetail.create({
            data: {
              salary_rule_id: rule.id,
              component: d.component,
              amount: d.amount ? BigInt(d.amount) : null,
              formula: d.formula ?? null,
              params: (d.params ?? undefined) as Prisma.InputJsonValue | undefined,
              order: d.order ?? index,
            },
          }),
        ),
      )

      return {
        ...rule,
        details: details.map((d) => ({
          id: d.id,
          component: d.component,
          amount: d.amount?.toString() ?? null,
          formula: d.formula,
          params: d.params,
          order: d.order,
        })),
      }
    })
  }

  async update(id: number, dto: UpdateSalaryRuleDto) {
    const existing = await this.prisma.salaryRule.findUnique({
      where: { id },
    })

    if (!existing) {
      throw new NotFoundException(`Bảng lương #${id} không tồn tại`)
    }

    // Validate formulas if details provided
    if (dto.details) {
      for (const detail of dto.details) {
        if (detail.formula && !validateFormula(detail.formula)) {
          throw new BadRequestException(
            `Công thức không hợp lệ cho component "${detail.component}": ${detail.formula}`,
          )
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.salaryRule.update({
        where: { id },
        data: {
          ...(dto.position !== undefined && { position: dto.position }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
        },
      })

      let details
      if (dto.details) {
        // Replace all details: delete old, create new
        await tx.salaryRuleDetail.deleteMany({
          where: { salary_rule_id: id },
        })

        details = await Promise.all(
          dto.details.map((d, index) =>
            tx.salaryRuleDetail.create({
              data: {
                salary_rule_id: id,
                component: d.component,
                amount: d.amount ? BigInt(d.amount) : null,
                formula: d.formula ?? null,
                params: (d.params ?? undefined) as Prisma.InputJsonValue | undefined,
                order: d.order ?? index,
              },
            }),
          ),
        )
      } else {
        const rawDetails = await tx.salaryRuleDetail.findMany({
          where: { salary_rule_id: id },
          orderBy: { order: 'asc' },
        })
        details = rawDetails
      }

      return {
        ...rule,
        details: details.map((d) => ({
          id: d.id,
          component: d.component,
          amount: d.amount?.toString() ?? null,
          formula: d.formula,
          params: d.params,
          order: d.order,
        })),
      }
    })
  }
}
