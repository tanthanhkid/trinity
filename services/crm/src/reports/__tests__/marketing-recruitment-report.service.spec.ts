import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { MarketingRecruitmentReportService } from '../marketing-recruitment-report.service';
import type { MarketingAccountFilter } from '../marketing-recruitment-report.service';

const mockPrisma = {
  $queryRaw: jest.fn(),
};

const baseFilter: MarketingAccountFilter = {
  scopeIds: [10],
  dateFrom: new Date('2026-06-01T00:00:00+07:00'),
  dateTo: new Date('2026-06-30T23:59:59+07:00'),
};

describe('MarketingRecruitmentReportService', () => {
  let service: MarketingRecruitmentReportService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketingRecruitmentReportService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<MarketingRecruitmentReportService>(MarketingRecruitmentReportService);
    jest.clearAllMocks();
  });

  describe('getRecruitmentOverview', () => {
    it('trả về 4 chỉ số CÓ data từ 4 query raw SQL', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ cnt: 2n }]) // positions
        .mockResolvedValueOnce([{ cnt: 8n }]) // interested
        .mockResolvedValueOnce([{ cnt: 3n }]) // interviewed
        .mockResolvedValueOnce([{ cnt: 1n }]); // hired

      const result = await service.getRecruitmentOverview(baseFilter);

      expect(result.positions_posted).toBe(2);
      expect(result.candidates_interested).toBe(8);
      expect(result.candidates_interviewed).toBe(3);
      expect(result.candidates_hired).toBe(1);
    });

    it('3 field KHÔNG có nguồn dữ liệu PHẢI trả null + available:false (KHÔNG bịa số)', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ cnt: 0n }]);

      const result = await service.getRecruitmentOverview(baseFilter);

      expect(result.recruitment_messages).toBeNull();
      expect(result.recruitment_messages_available).toBe(false);
      expect(result.cv_received).toBeNull();
      expect(result.cv_received_available).toBe(false);
    });

    it('scopeIds=null (phạm vi toàn bộ) → vẫn trả 0 an toàn khi không có rows', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      const result = await service.getRecruitmentOverview({ ...baseFilter, scopeIds: null });
      expect(result.positions_posted).toBe(0);
      expect(result.candidates_hired).toBe(0);
    });
  });
});
