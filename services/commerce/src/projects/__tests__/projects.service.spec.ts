import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { ProjectsService } from '../projects.service';

const mockProject = {
  id: 1,
  name: 'Sample Project',
  code: 'sample_project',
  color: 'blue',
  is_active: true,
  created_by: 1,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const mockPrisma = {
  project: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
};

describe('ProjectsService', () => {
  let service: ProjectsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('nên tạo dự án mới', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null);
      mockPrisma.project.create.mockResolvedValue(mockProject);

      const result = await service.create({ name: 'Default project', code: 'sample_project' }, 1);

      expect(mockPrisma.project.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'sample_project', created_by: 1 }),
        }),
      );
      expect(result.code).toBe('sample_project');
    });

    it('P2002 từ unique index (hai request song song) → 409 chứ không phải 500', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null);
      mockPrisma.project.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.create({ name: 'Default project', code: 'sample_project' }, 1),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('nên soft delete bằng cách set is_active=false', async () => {
      const deactivated = { ...mockProject, is_active: false };
      mockPrisma.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.project.update.mockResolvedValue(deactivated);

      const result = await service.remove(1);

      expect(mockPrisma.project.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { is_active: false },
      });
      expect(result.is_active).toBe(false);
      expect(result.id).toBe(1);
    });

    it('nên throw NotFoundException khi dự án không tồn tại', async () => {
      mockPrisma.project.findUnique.mockResolvedValue(null);

      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.project.update).not.toHaveBeenCalled();
    });

    it('nên filter dự án đã xoá (is_active=false) khỏi findAll mặc định', async () => {
      mockPrisma.project.findMany.mockResolvedValue([mockProject]);

      await service.findAll(); // includeInactive = false (default)

      expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ is_active: true }),
        }),
      );
    });

    it('nên trả cả dự án đã xoá khi includeInactive=true', async () => {
      const deactivated = { ...mockProject, is_active: false };
      mockPrisma.project.findMany.mockResolvedValue([deactivated]);

      const result = await service.findAll(true);

      expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
        }),
      );
      expect(result).toHaveLength(1);
    });
  });
});
