import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import { findUserIdsWithPermission } from '../common/helpers/permission-roster.helper';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import { UpdateCandidateDto } from './dto/update-candidate.dto';
import {
  QueryCandidatesDto,
  QueryRecruitmentStatsDto,
} from './dto/query-candidates.dto';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';
import { QueryPositionsDto } from './dto/query-positions.dto';

type CandidateRow = {
  id: number;
  full_name: string;
  phone: string | null;
  email: string | null;
  position: string | null;
  department: string | null;
  source: string | null;
  stage: string;
  decision: string;
  recruitment_type: string;
  applied_date: Date | null;
  cost: number | null;
  note: string | null;
  gender: string | null;
  interview_date: Date | null;
  interview_time: string | null;
  recruiter_id: number | null;
  created_at: Date;
};

type PositionRow = {
  id: number;
  job_code: string;
  department: string;
  team: string | null;
  position_title: string;
  headcount: number;
  recruiter_id: number | null;
  opened_date: Date | null;
  expected_start_date: Date | null;
  description: string | null;
  requirements: string | null;
  recruitment_cost: number | null;
  status: string;
  created_at: Date;
};

@Injectable()
export class RecruitmentService {
  constructor(private readonly prisma: PrismaService) {}

  async list(dto: QueryCandidatesDto) {
    const page = Math.max(1, dto.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, dto.page_size ?? 25));
    const skip = (page - 1) * pageSize;

    const where: Prisma.RecruitmentCandidateWhereInput = {};
    if (dto.stage) where.stage = dto.stage;
    if (dto.source) where.source = dto.source;
    if (dto.decision) where.decision = dto.decision;
    if (dto.recruitment_type) where.recruitment_type = dto.recruitment_type;
    if (dto.search?.trim()) {
      const s = dto.search.trim();
      where.OR = [
        { full_name: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
      ];
    }

    const sortFields = new Set([
      'full_name', 'applied_date', 'cost', 'stage', 'decision', 'source',
    ]);
    const orderBy: Prisma.RecruitmentCandidateOrderByWithRelationInput[] =
      dto.sort_by && sortFields.has(dto.sort_by)
        ? [
            {
              [dto.sort_by]: {
                sort: dto.sort_dir === 'asc' ? 'asc' : 'desc',
                nulls: 'last',
              },
            } as Prisma.RecruitmentCandidateOrderByWithRelationInput,
            { id: 'desc' },
          ]
        : [{ applied_date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];

    const [total, rows] = await Promise.all([
      this.prisma.recruitmentCandidate.count({ where }),
      this.prisma.recruitmentCandidate.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
    ]);

    const nameMap = await this.resolveRecruiterNames(
      rows.map((r) => r.recruiter_id),
    );

    return {
      data: rows.map((r) =>
        this.mapCandidate(r, this.pickName(nameMap, r.recruiter_id)),
      ),
      pagination: {
        total,
        page,
        page_size: pageSize,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
        hasMore: skip + rows.length < total,
      },
    };
  }

  async create(dto: CreateCandidateDto, createdBy: number) {
    const row = await this.prisma.recruitmentCandidate.create({
      data: {
        full_name: dto.full_name,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        position: dto.position ?? null,
        department: dto.department ?? null,
        source: dto.source ?? null,
        stage: dto.stage ?? 'applied',
        decision: dto.decision ?? 'pending',
        recruitment_type: dto.recruitment_type ?? 'external',
        applied_date: dto.applied_date ? new Date(dto.applied_date) : null,
        cost: dto.cost ?? null,
        note: dto.note ?? null,
        gender: dto.gender ?? null,
        interview_date: dto.interview_date ? new Date(dto.interview_date) : null,
        interview_time: dto.interview_time ?? null,
        recruiter_id: dto.recruiter_id ?? null,
        created_by: createdBy,
      },
    });
    return this.mapCandidate(row, await this.resolveOneName(row.recruiter_id));
  }

  async update(id: number, dto: UpdateCandidateDto) {
    await this.ensureExists(id);
    const data: Prisma.RecruitmentCandidateUpdateInput = {};
    if (dto.full_name !== undefined) data.full_name = dto.full_name;
    if (dto.phone !== undefined) data.phone = dto.phone ?? null;
    if (dto.email !== undefined) data.email = dto.email ?? null;
    if (dto.position !== undefined) data.position = dto.position ?? null;
    if (dto.department !== undefined) data.department = dto.department ?? null;
    if (dto.source !== undefined) data.source = dto.source ?? null;
    if (dto.stage !== undefined) data.stage = dto.stage;
    if (dto.decision !== undefined) data.decision = dto.decision;
    if (dto.recruitment_type !== undefined)
      data.recruitment_type = dto.recruitment_type;
    if (dto.applied_date !== undefined)
      data.applied_date = dto.applied_date ? new Date(dto.applied_date) : null;
    if (dto.cost !== undefined) data.cost = dto.cost ?? null;
    if (dto.note !== undefined) data.note = dto.note ?? null;
    if (dto.gender !== undefined) data.gender = dto.gender ?? null;
    if (dto.interview_date !== undefined)
      data.interview_date = dto.interview_date
        ? new Date(dto.interview_date)
        : null;
    if (dto.interview_time !== undefined)
      data.interview_time = dto.interview_time ?? null;
    if (dto.recruiter_id !== undefined)
      data.recruiter_id = dto.recruiter_id ?? null;
    const row = await this.prisma.recruitmentCandidate.update({
      where: { id },
      data,
    });
    return this.mapCandidate(row, await this.resolveOneName(row.recruiter_id));
  }

  async remove(id: number) {
    await this.ensureExists(id);
    await this.prisma.recruitmentCandidate.delete({ where: { id } });
    return { ok: true, id };
  }

  async stats(dto: QueryRecruitmentStatsDto) {
    const where: Prisma.RecruitmentCandidateWhereInput = {};
    const dateFilter: Prisma.DateTimeNullableFilter = {};
    if (dto.date_from) dateFilter.gte = new Date(dto.date_from);
    if (dto.date_to) dateFilter.lte = new Date(dto.date_to);
    if (dto.date_from || dto.date_to) where.applied_date = dateFilter;

    const [total, costAgg, bySource, byStage, byDecision, byTypeRaw] =
      await Promise.all([
        this.prisma.recruitmentCandidate.count({ where }),
        this.prisma.recruitmentCandidate.aggregate({ where, _sum: { cost: true } }),
        this.prisma.recruitmentCandidate.groupBy({
          by: ['source'],
          where,
          _count: { _all: true },
        }),
        this.prisma.recruitmentCandidate.groupBy({
          by: ['stage'],
          where,
          _count: { _all: true },
        }),
        this.prisma.recruitmentCandidate.groupBy({
          by: ['decision'],
          where,
          _count: { _all: true },
        }),
        this.prisma.recruitmentCandidate.groupBy({
          by: ['recruitment_type'],
          where,
          _count: { _all: true },
        }),
      ]);

    const monthWhere = Prisma.sql`applied_date IS NOT NULL
      ${dto.date_from ? Prisma.sql`AND applied_date >= ${new Date(dto.date_from)}` : Prisma.empty}
      ${dto.date_to ? Prisma.sql`AND applied_date <= ${new Date(dto.date_to)}` : Prisma.empty}`;
    const monthRows = await this.prisma.$queryRaw<
      Array<{ month: string; count: bigint }>
    >(Prisma.sql`SELECT to_char(applied_date, 'YYYY-MM') AS month, count(*)::bigint AS count
        FROM recruitment_candidates WHERE ${monthWhere} GROUP BY 1 ORDER BY 1`);

    const byType = { internal: 0, external: 0 };
    for (const t of byTypeRaw) {
      if (t.recruitment_type === 'internal') byType.internal = t._count._all;
      else if (t.recruitment_type === 'external') byType.external = t._count._all;
    }

    return {
      total,
      total_cost: costAgg._sum.cost ?? 0,
      by_source: Object.fromEntries(
        bySource.map((s) => [s.source ?? 'Không rõ', s._count._all]),
      ),
      by_stage: Object.fromEntries(byStage.map((s) => [s.stage, s._count._all])),
      by_decision: Object.fromEntries(
        byDecision.map((s) => [s.decision, s._count._all]),
      ),
      by_type: byType,
      by_month: monthRows.map((r) => ({ month: r.month, count: Number(r.count) })),
    };
  }

  // ── Vị trí tuyển dụng ───────────────────────────────────────────────────

  async listPositions(dto: QueryPositionsDto) {
    const page = Math.max(1, dto.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, dto.page_size ?? 25));
    const skip = (page - 1) * pageSize;

    const where: Prisma.RecruitmentPositionWhereInput = {};
    if (dto.status) where.status = dto.status;
    if (dto.department) where.department = dto.department;
    if (dto.search?.trim()) {
      const s = dto.search.trim();
      where.OR = [
        { job_code: { contains: s, mode: 'insensitive' } },
        { position_title: { contains: s, mode: 'insensitive' } },
        { team: { contains: s, mode: 'insensitive' } },
      ];
    }

    const sortFields = new Set([
      'job_code', 'department', 'position_title', 'headcount', 'opened_date', 'recruitment_cost', 'status',
    ]);
    const orderBy: Prisma.RecruitmentPositionOrderByWithRelationInput[] =
      dto.sort_by && sortFields.has(dto.sort_by)
        ? [
            {
              [dto.sort_by]: {
                sort: dto.sort_dir === 'asc' ? 'asc' : 'desc',
                nulls: 'last',
              },
            } as Prisma.RecruitmentPositionOrderByWithRelationInput,
            { id: 'desc' },
          ]
        : [{ opened_date: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }];

    const [total, rows] = await Promise.all([
      this.prisma.recruitmentPosition.count({ where }),
      this.prisma.recruitmentPosition.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
    ]);

    const nameMap = await this.resolveRecruiterNames(
      rows.map((r) => r.recruiter_id),
    );

    return {
      data: rows.map((r) =>
        this.mapPosition(r, this.pickName(nameMap, r.recruiter_id)),
      ),
      pagination: {
        total,
        page,
        page_size: pageSize,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
        hasMore: skip + rows.length < total,
      },
    };
  }

  async createPosition(dto: CreatePositionDto, createdBy: number) {
    const row = await this.prisma.recruitmentPosition.create({
      data: {
        job_code: dto.job_code,
        department: dto.department,
        team: dto.team ?? null,
        position_title: dto.position_title,
        headcount: dto.headcount,
        recruiter_id: dto.recruiter_id ?? null,
        opened_date: dto.opened_date ? new Date(dto.opened_date) : null,
        expected_start_date: dto.expected_start_date
          ? new Date(dto.expected_start_date)
          : null,
        description: dto.description ?? null,
        requirements: dto.requirements ?? null,
        recruitment_cost: dto.recruitment_cost ?? null,
        status: dto.status ?? 'open',
        created_by: createdBy,
      },
    });
    return this.mapPosition(row, await this.resolveOneName(row.recruiter_id));
  }

  async updatePosition(id: number, dto: UpdatePositionDto) {
    await this.ensurePositionExists(id);
    const data: Prisma.RecruitmentPositionUpdateInput = {};
    if (dto.job_code !== undefined) data.job_code = dto.job_code;
    if (dto.department !== undefined) data.department = dto.department;
    if (dto.team !== undefined) data.team = dto.team || null;
    if (dto.position_title !== undefined)
      data.position_title = dto.position_title;
    if (dto.headcount !== undefined) data.headcount = dto.headcount;
    if (dto.recruiter_id !== undefined)
      data.recruiter_id = dto.recruiter_id ?? null;
    if (dto.opened_date !== undefined)
      data.opened_date = dto.opened_date ? new Date(dto.opened_date) : null;
    if (dto.expected_start_date !== undefined)
      data.expected_start_date = dto.expected_start_date
        ? new Date(dto.expected_start_date)
        : null;
    if (dto.description !== undefined) data.description = dto.description || null;
    if (dto.requirements !== undefined)
      data.requirements = dto.requirements || null;
    if (dto.recruitment_cost !== undefined)
      data.recruitment_cost = dto.recruitment_cost ?? null;
    if (dto.status !== undefined) data.status = dto.status;
    const row = await this.prisma.recruitmentPosition.update({
      where: { id },
      data,
    });
    return this.mapPosition(row, await this.resolveOneName(row.recruiter_id));
  }

  async removePosition(id: number) {
    await this.ensurePositionExists(id);
    await this.prisma.recruitmentPosition.delete({ where: { id } });
    return { ok: true, id };
  }

  // Danh sách user làm "Người tuyển dụng phụ trách" — bất kỳ ai giữ quyền
  // `recruitment.manage` (do admin tự cấu hình qua vai trò, xem
  // `findUserIdsWithPermission`).
  async listRecruiters() {
    const ids = await findUserIdsWithPermission(this.prisma, 'recruitment.manage');
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, deleted_at: null },
      select: { id: true, full_name: true, email: true },
      orderBy: { full_name: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
    }));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensureExists(id: number) {
    const c = await this.prisma.recruitmentCandidate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Không tìm thấy ứng viên');
  }

  private async ensurePositionExists(id: number) {
    const p = await this.prisma.recruitmentPosition.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Không tìm thấy vị trí tuyển dụng');
  }

  // Map recruiter_id (soft-FK → users.id) sang tên đầy đủ — 1 query duy nhất.
  private async resolveRecruiterNames(
    ids: Array<number | null>,
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const distinct = [
      ...new Set(ids.filter((x): x is number => x != null)),
    ];
    if (distinct.length === 0) return map;
    const users = await this.prisma.user.findMany({
      where: { id: { in: distinct } },
      select: { id: true, full_name: true },
    });
    for (const u of users) map.set(u.id, u.full_name);
    return map;
  }

  private async resolveOneName(id: number | null): Promise<string | null> {
    if (id == null) return null;
    const map = await this.resolveRecruiterNames([id]);
    return map.get(id) ?? null;
  }

  private pickName(
    map: Map<number, string>,
    id: number | null,
  ): string | null {
    return id != null ? (map.get(id) ?? null) : null;
  }

  private mapCandidate(r: CandidateRow, recruiterName: string | null) {
    return {
      id: r.id,
      full_name: r.full_name,
      phone: r.phone,
      email: r.email,
      position: r.position,
      department: r.department,
      source: r.source,
      stage: r.stage,
      decision: r.decision,
      recruitment_type: r.recruitment_type,
      applied_date: r.applied_date
        ? r.applied_date.toISOString().slice(0, 10)
        : null,
      cost: r.cost,
      note: r.note,
      gender: r.gender,
      interview_date: r.interview_date
        ? r.interview_date.toISOString().slice(0, 10)
        : null,
      interview_time: r.interview_time,
      recruiter_id: r.recruiter_id,
      recruiter_name: recruiterName,
      created_at: r.created_at,
    };
  }

  private mapPosition(r: PositionRow, recruiterName: string | null) {
    return {
      id: r.id,
      job_code: r.job_code,
      department: r.department,
      team: r.team,
      position_title: r.position_title,
      headcount: r.headcount,
      recruiter_id: r.recruiter_id,
      recruiter_name: recruiterName,
      opened_date: r.opened_date
        ? r.opened_date.toISOString().slice(0, 10)
        : null,
      expected_start_date: r.expected_start_date
        ? r.expected_start_date.toISOString().slice(0, 10)
        : null,
      description: r.description,
      requirements: r.requirements,
      recruitment_cost: r.recruitment_cost,
      status: r.status,
      created_at: r.created_at,
    };
  }
}
