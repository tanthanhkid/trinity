import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';

/** Bộ lọc báo cáo tuyển dụng theo người phụ trách. */
export interface MarketingAccountFilter {
  /** null = không filter (toàn bộ) */
  scopeIds: number[] | null;
  dateFrom: Date;
  dateTo: Date;
}

export interface RecruitmentOverview {
  positions_posted: number;
  candidates_interested: number;
  candidates_interviewed: number;
  candidates_hired: number;
  /** Không có nguồn dữ liệu (KHÔNG bịa số). */
  recruitment_messages: null;
  recruitment_messages_available: false;
  cv_received: null;
  cv_received_available: false;
}

/**
 * nhóm "Tuyển dụng" — chỉ số CÓ nguồn dữ liệu qua recruiter_id/created_by
 * trên RecruitmentPosition/RecruitmentCandidate. 2 chỉ số KHÔNG có nguồn (tin nhắn
 * tuyển dụng, CV nhận) trả null + available:false — KHÔNG bịa data.
 */
@Injectable()
export class MarketingRecruitmentReportService {
  constructor(private readonly prisma: PrismaService) {}

  private buildScopeCondition(scopeIds: number[] | null): Prisma.Sql {
    if (!scopeIds) return Prisma.sql`TRUE`;
    if (scopeIds.length === 0) return Prisma.sql`FALSE`;
    return Prisma.sql`(recruiter_id IN (${Prisma.join(scopeIds)}) OR created_by IN (${Prisma.join(scopeIds)}))`;
  }

  async getRecruitmentOverview(filter: MarketingAccountFilter): Promise<RecruitmentOverview> {
    const scopeCond = this.buildScopeCondition(filter.scopeIds);
    const { dateFrom, dateTo } = filter;

    const [positionsRows, interestedRows, interviewedRows, hiredRows] = await Promise.all([
      this.prisma.$queryRaw<{ cnt: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM recruitment_positions
        WHERE ${scopeCond}
          AND opened_date >= ${dateFrom} AND opened_date < ${dateTo}
      `),
      this.prisma.$queryRaw<{ cnt: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM recruitment_candidates
        WHERE ${scopeCond}
          AND applied_date >= ${dateFrom} AND applied_date < ${dateTo}
      `),
      this.prisma.$queryRaw<{ cnt: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM recruitment_candidates
        WHERE ${scopeCond}
          AND applied_date >= ${dateFrom} AND applied_date < ${dateTo}
          AND interview_date IS NOT NULL
      `),
      this.prisma.$queryRaw<{ cnt: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM recruitment_candidates
        WHERE ${scopeCond}
          AND applied_date >= ${dateFrom} AND applied_date < ${dateTo}
          AND decision = 'hired'
      `),
    ]);

    return {
      positions_posted: Number(positionsRows[0]?.cnt ?? 0),
      candidates_interested: Number(interestedRows[0]?.cnt ?? 0),
      candidates_interviewed: Number(interviewedRows[0]?.cnt ?? 0),
      candidates_hired: Number(hiredRows[0]?.cnt ?? 0),
      recruitment_messages: null,
      recruitment_messages_available: false,
      cv_received: null,
      cv_received_available: false,
    };
  }
}
