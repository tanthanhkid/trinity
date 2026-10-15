import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { CreateJobTitleDto } from './dto/create-job-title.dto'
import { UpdateJobTitleDto } from './dto/update-job-title.dto'
import { QueryJobTitlesDto } from './dto/query-job-titles.dto'

export interface JobTitleRow {
  id: number
  category: string
  rank_code: string
  name: string
  symbol: string
  base_salary: string
  standard_target: string
  default_insurance_salary: string | null // mức đóng BHXH mặc định theo chức vụ
  review_cycle_months: number
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
}

const JOB_TITLE_SELECT = {
  id: true,
  category: true,
  rank_code: true,
  name: true,
  symbol: true,
  base_salary: true,
  standard_target: true,
  default_insurance_salary: true,
  review_cycle_months: true,
  is_active: true,
  sort_order: true,
  created_at: true,
  updated_at: true,
} as const

function mapJobTitle(row: {
  id: number
  category: string
  rank_code: string
  name: string
  symbol: string
  base_salary: bigint
  standard_target: bigint
  default_insurance_salary: bigint | null
  review_cycle_months: number
  is_active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
}) {
  return {
    ...row,
    base_salary: row.base_salary.toString(),
    standard_target: row.standard_target.toString(),
    // BigInt? → string|null (null = chưa cấu hình → payroll fallback lương cơ bản)
    default_insurance_salary: row.default_insurance_salary?.toString() ?? null,
  }
}

@Injectable()
export class JobTitlesService {
  private readonly logger = new Logger(JobTitlesService.name)

  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: QueryJobTitlesDto) {
    const where: Record<string, unknown> = {}
    if (query.category !== undefined) where.category = query.category
    if (query.is_active !== undefined) where.is_active = query.is_active

    const rows = await this.prisma.jobTitle.findMany({
      where,
      select: JOB_TITLE_SELECT,
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    })
    return rows.map(mapJobTitle)
  }

  async findOne(id: number) {
    const row = await this.prisma.jobTitle.findUnique({
      where: { id },
      select: JOB_TITLE_SELECT,
    })
    if (!row) throw new NotFoundException(`Chức danh #${id} không tồn tại`)
    return mapJobTitle(row)
  }

  async create(dto: CreateJobTitleDto) {
    const exists = await this.prisma.jobTitle.findUnique({
      where: { rank_code: dto.rank_code },
      select: { id: true },
    })
    if (exists) {
      throw new ConflictException(`Mã cấp bậc "${dto.rank_code}" đã tồn tại`)
    }

    const row = await this.prisma.jobTitle.create({
      data: {
        category: dto.category,
        rank_code: dto.rank_code,
        name: dto.name,
        symbol: dto.symbol,
        base_salary: dto.base_salary ?? 0,
        standard_target: dto.standard_target ?? 0,
        default_insurance_salary: dto.default_insurance_salary ?? null,
        review_cycle_months: dto.review_cycle_months,
        is_active: dto.is_active ?? true,
        sort_order: dto.sort_order ?? 0,
      },
      select: JOB_TITLE_SELECT,
    })
    this.logger.log(`Tạo chức danh mới: ${row.rank_code} — ${row.name}`)
    return mapJobTitle(row)
  }

  async update(id: number, dto: UpdateJobTitleDto) {
    await this.findOne(id)

    const data: Record<string, unknown> = {}
    if (dto.category !== undefined) data.category = dto.category
    if (dto.name !== undefined) data.name = dto.name
    if (dto.symbol !== undefined) data.symbol = dto.symbol
    if (dto.base_salary !== undefined) data.base_salary = dto.base_salary
    if (dto.standard_target !== undefined) data.standard_target = dto.standard_target
    if (dto.default_insurance_salary !== undefined)
      data.default_insurance_salary = dto.default_insurance_salary // (null = clear)
    if (dto.review_cycle_months !== undefined) data.review_cycle_months = dto.review_cycle_months
    if (dto.is_active !== undefined) data.is_active = dto.is_active
    if (dto.sort_order !== undefined) data.sort_order = dto.sort_order

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Không có trường nào cần cập nhật')
    }

    const row = await this.prisma.jobTitle.update({
      where: { id },
      data,
      select: JOB_TITLE_SELECT,
    })
    return mapJobTitle(row)
  }

  async remove(id: number) {
    await this.findOne(id)
    await this.prisma.jobTitle.delete({ where: { id } })
    this.logger.log(`Xoá chức danh #${id}`)
    return { ok: true }
  }
}
