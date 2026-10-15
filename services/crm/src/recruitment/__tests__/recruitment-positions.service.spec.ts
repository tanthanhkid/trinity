import { NotFoundException } from '@nestjs/common';
import { RecruitmentService } from '../recruitment.service';

function makePrisma() {
  return {
    recruitmentPosition: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn(),
    },
    recruitmentCandidate: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    role: {
      findMany: jest.fn(),
    },
    userRole: {
      findMany: jest.fn(),
    },
  };
}

describe('RecruitmentService — vị trí tuyển dụng', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: RecruitmentService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new RecruitmentService(prisma as never);
  });

  it('createPosition lưu đủ field + resolve tên người tuyển dụng', async () => {
    prisma.recruitmentPosition.create.mockResolvedValue({
      id: 1,
      job_code: 'KD-01',
      department: 'Kinh doanh',
      team: null,
      position_title: 'Nhân viên kinh doanh',
      headcount: 3,
      recruiter_id: 7,
      opened_date: new Date('2026-06-01'),
      expected_start_date: null,
      description: null,
      requirements: null,
      status: 'open',
      created_at: new Date('2026-06-01'),
    });
    prisma.user.findMany.mockResolvedValue([{ id: 7, full_name: 'HR An' }]);

    const res = await service.createPosition(
      {
        job_code: 'KD-01',
        department: 'Kinh doanh',
        position_title: 'Nhân viên kinh doanh',
        headcount: 3,
        recruiter_id: 7,
        opened_date: '2026-06-01',
      } as never,
      99,
    );

    expect(prisma.recruitmentPosition.create).toHaveBeenCalledTimes(1);
    expect(res.recruiter_name).toBe('HR An');
    expect(res.opened_date).toBe('2026-06-01');
    expect(res.status).toBe('open');
  });

  it('listPositions trả pagination + recruiter_name null khi chưa gán', async () => {
    prisma.recruitmentPosition.count.mockResolvedValue(1);
    prisma.recruitmentPosition.findMany.mockResolvedValue([
      {
        id: 1,
        job_code: 'KD-01',
        department: 'Kinh doanh',
        team: 'Team A',
        position_title: 'Sale',
        headcount: 3,
        recruiter_id: null,
        opened_date: null,
        expected_start_date: null,
        description: null,
        requirements: null,
        status: 'open',
        created_at: new Date(),
      },
    ]);
    prisma.user.findMany.mockResolvedValue([]);

    const res = await service.listPositions({ page: 1, page_size: 25 } as never);
    expect(res.pagination.total).toBe(1);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].recruiter_name).toBeNull();
  });

  it('updatePosition ném NotFound khi không tồn tại', async () => {
    prisma.recruitmentPosition.findUnique.mockResolvedValue(null);
    await expect(
      service.updatePosition(404, { status: 'closed' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removePosition trả ok khi tồn tại', async () => {
    prisma.recruitmentPosition.findUnique.mockResolvedValue({ id: 1 });
    prisma.recruitmentPosition.delete.mockResolvedValue({ id: 1 });
    const res = await service.removePosition(1);
    expect(res).toEqual({ ok: true, id: 1 });
  });

  it('listRecruiters map id/full_name/email (roster theo quyền recruitment.manage)', async () => {
    prisma.role.findMany.mockResolvedValue([{ id: 1 }]);
    prisma.userRole.findMany.mockResolvedValue([{ user_id: 7 }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, full_name: 'HR An', email: 'an@example.net' },
    ]);
    const res = await service.listRecruiters();
    expect(res).toEqual([{ id: 7, full_name: 'HR An', email: 'an@example.net' }]);
    expect(prisma.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { is_system: true },
            { grants: { some: { permission: 'recruitment.manage' } } },
          ],
        },
      }),
    );
  });

  it('listRecruiters: không role nào giữ recruitment.manage → mảng rỗng, không query user', async () => {
    prisma.role.findMany.mockResolvedValue([]);
    const res = await service.listRecruiters();
    expect(res).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
