import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SettingsOptionsService } from './settings-options.service';
import { PrismaService } from '@trinity/prisma';

function createMockPrisma() {
  return {
    settingOption: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

describe('SettingsOptionsService', () => {
  let service: SettingsOptionsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsOptionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<SettingsOptionsService>(SettingsOptionsService);
  });

  // ===== findAll =====
  describe('findAll', () => {
    it('trả data active=true mặc định + sort theo group_key + sort_order', async () => {
      const rows = [
        { id: 1, group_key: 'contact_source', value: 'web_form', label: 'Website', sort_order: 1, is_active: true, is_system: true, metadata: null },
      ];
      prisma.settingOption.findMany.mockResolvedValue(rows);

      const res = await service.findAll({ group: 'contact_source' });

      expect(res.data).toEqual(rows);
      expect(prisma.settingOption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { group_key: 'contact_source', is_active: true },
          orderBy: [
            { group_key: 'asc' },
            { sort_order: 'asc' },
            { id: 'asc' },
          ],
        }),
      );
    });

    it('mỗi call đều query DB (không cache)', async () => {
      prisma.settingOption.findMany.mockResolvedValue([]);

      await service.findAll({ group: 'contact_source' });
      await service.findAll({ group: 'contact_source' });

      expect(prisma.settingOption.findMany).toHaveBeenCalledTimes(2);
    });

    it('active=false query cả is_active=false rows', async () => {
      prisma.settingOption.findMany.mockResolvedValue([]);

      await service.findAll({ group: 'contact_source', active: false });

      const call = prisma.settingOption.findMany.mock.calls[0][0];
      expect(call.where.is_active).toBeUndefined();
    });
  });

  // ===== create =====
  describe('create', () => {
    it('tạo option mới', async () => {
      prisma.settingOption.findUnique.mockResolvedValue(null);
      prisma.settingOption.create.mockResolvedValue({
        id: 100,
        group_key: 'contact_source',
        value: 'new_src',
        label: 'Nguồn mới',
        sort_order: 20,
        is_active: true,
        is_system: false,
        metadata: null,
      });

      const created = await service.create(
        { group_key: 'contact_source', value: 'new_src', label: 'Nguồn mới' },
        42,
      );

      expect(created.value).toBe('new_src');
      expect(prisma.settingOption.create).toHaveBeenCalled();
    });

    it('duplicate group_key + value → ConflictException', async () => {
      prisma.settingOption.findUnique.mockResolvedValue({ id: 1 });

      await expect(
        service.create(
          { group_key: 'contact_source', value: 'web_form', label: 'dup' },
          1,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('force is_system=false cho option user tạo', async () => {
      prisma.settingOption.findUnique.mockResolvedValue(null);
      prisma.settingOption.create.mockResolvedValue({
        id: 1,
        group_key: 'contact_source',
        value: 'x',
        label: 'X',
        sort_order: 0,
        is_active: true,
        is_system: false,
        metadata: null,
      });

      await service.create(
        { group_key: 'contact_source', value: 'x', label: 'X' },
        1,
      );

      const call = prisma.settingOption.create.mock.calls[0][0];
      expect(call.data.is_system).toBe(false);
    });
  });

  // ===== update =====
  describe('update', () => {
    it('update label + sort_order', async () => {
      prisma.settingOption.findUnique.mockResolvedValue({
        id: 5,
        group_key: 'contact_detail_status',
      });
      prisma.settingOption.update.mockResolvedValue({
        id: 5,
        group_key: 'contact_detail_status',
        value: 'follow_up_later',
        label: 'Hẹn lại (đổi)',
        sort_order: 10,
        is_active: true,
        is_system: false,
        metadata: null,
      });

      const res = await service.update(5, { label: 'Hẹn lại (đổi)', sort_order: 10 }, 1);

      expect(res.label).toBe('Hẹn lại (đổi)');
      const call = prisma.settingOption.update.mock.calls[0][0];
      expect(call.data.label).toBe('Hẹn lại (đổi)');
      expect(call.data.sort_order).toBe(10);
      expect(call.data.group_key).toBeUndefined();
      expect(call.data.value).toBeUndefined();
    });

    it('option không tồn tại → NotFoundException', async () => {
      prisma.settingOption.findUnique.mockResolvedValue(null);
      await expect(
        service.update(999, { label: 'X' }, 1),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ===== remove =====
  describe('remove', () => {
    it('soft delete: set is_active=false', async () => {
      prisma.settingOption.findUnique.mockResolvedValue({
        id: 1,
        group_key: 'contact_detail_status',
        is_system: false,
        is_active: true,
      });
      prisma.settingOption.update.mockResolvedValue({});

      const res = await service.remove(1, 42);

      expect(res).toEqual({ deleted: true, id: 1 });
      expect(prisma.settingOption.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { is_active: false, updated_by: 42 },
      });
    });

    it('is_system=true → BadRequestException', async () => {
      prisma.settingOption.findUnique.mockResolvedValue({
        id: 2,
        group_key: 'contact_stage',
        is_system: true,
        is_active: true,
      });

      await expect(service.remove(2, 1)).rejects.toThrow(BadRequestException);
      expect(prisma.settingOption.update).not.toHaveBeenCalled();
    });

    it('option không tồn tại → NotFoundException', async () => {
      prisma.settingOption.findUnique.mockResolvedValue(null);
      await expect(service.remove(999, 1)).rejects.toThrow(NotFoundException);
    });

    it('đã soft-deleted rồi (is_active=false) → không call update, vẫn return ok', async () => {
      prisma.settingOption.findUnique.mockResolvedValue({
        id: 3,
        group_key: 'contact_detail_status',
        is_system: false,
        is_active: false,
      });

      const res = await service.remove(3, 1);

      expect(res).toEqual({ deleted: true, id: 3 });
      expect(prisma.settingOption.update).not.toHaveBeenCalled();
    });
  });
});
