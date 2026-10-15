import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AttendanceService,
  buildWorkdayList,
  buildLeaveWeekBuckets,
} from '../attendance.service';
import { PrismaService } from '@trinity/prisma';
import { StorageService } from '../../storage/storage.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import type { Request } from 'express';
import type { Readable } from 'stream';

// Helper để tạo mock request với IP
const makeReq = (ip: string): Request =>
  ({ headers: { 'cf-connecting-ip': ip }, ip, socket: {} } as unknown as Request);

// Mock ảnh selfie (FileInterceptor memoryStorage → buffer sẵn có)
const SELFIE = {
  buffer: Buffer.from('fake-jpeg'),
  mimetype: 'image/jpeg',
  originalname: 'selfie.jpg',
  size: 9,
} as Express.Multer.File;

// Helper để build PrismaService mock
const makePrisma = (overrides: Record<string, unknown> = {}) =>
  ({
    attendanceOffice: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    employee: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    attendanceRecord: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    // Mặc định rỗng — getWorkdaysMatrix + getEarlyLeaveStats query đơn về sớm (early_leave).
    attendanceRequest: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    user: { count: jest.fn(), findMany: jest.fn() },
    setting: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    // listRecords/toàn bộ luồng org-sort gọi loadTeamOrgLookup() → prisma.team.findMany.
    // Mặc định rỗng (không Team nào) — test riêng override khi cần resolve Team thật.
    team: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(),
    ...overrides,
  }) as unknown as PrismaService;

// Helper để build StorageService mock
const makeStorage = () =>
  ({
    upload: jest.fn().mockResolvedValue('uploaded-key'),
    getObjectStream: jest.fn(),
    getPresignedUrl: jest.fn(),
    // delete trả Promise<void> (khớp signature thật) → persistWithProofCleanup `.catch` an toàn.
    delete: jest.fn().mockResolvedValue(undefined),
  }) as unknown as StorageService;

// NotificationsService mock — AttendanceService constructor cần (DI). Các describe hiện tại
// không gọi method notify nào → object rỗng đủ để Nest resolve dependency.
const makeNotifications = () => ({}) as unknown as NotificationsService;

// ScopeService mock (RBAC quyền+phạm vi) — AttendanceService constructor cần (DI).
// Mặc định `ownerIds` trả 'all' khi test không quan tâm RBAC; test `resolveStatsScope` tự override theo ca.
const makeScope = () =>
  ({ ownerIds: jest.fn().mockResolvedValue('all') }) as unknown as ScopeService;

/** Dựng `AuthUser` giả cho test — `grants` rỗng vì hầu hết test không đụng RBAC. */
const authUser = (userId: number, grants: AuthUser['grants'] = {}): AuthUser => ({
  userId,
  email: `user-${userId}@t`,
  isAdmin: false,
  grants,
});

const OFFICE_IP = '203.0.113.108';
const OFFICE = { id: 1, name: 'Hà Nội', ips: [OFFICE_IP] };
const EMPLOYEE = { id: 10, registered_device_id: null, device_registered_at: null };
const DEVICE_ID = 'test-device-uuid-1234';

describe('AttendanceService — checkIn', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(async () => {
    prisma = makePrisma();
    storage = makeStorage();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('check-in thành công: upload selfie + ghi proof_key (đã bỏ đăng ký/kiểm tra thiết bị)', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE });
    (prisma.employee.update as jest.Mock).mockResolvedValue({});
    const mockRecord = { id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete' };
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue(mockRecord);

    const result = await service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE);

    expect(storage.upload).toHaveBeenCalledTimes(1);
    // Đã bỏ kiểm tra/đăng ký thiết bị → KHÔNG còn gọi employee.update
    expect(prisma.employee.update).not.toHaveBeenCalled();
    // proof_key + văn phòng khớp IP được ghi vào cả create lẫn update
    expect(prisma.attendanceRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          check_in_proof_key: expect.stringContaining('attendance/1/'),
          check_in_office_id: OFFICE.id,
        }),
        update: expect.objectContaining({
          check_in_proof_key: expect.stringContaining('attendance/1/'),
          check_in_office_id: OFFICE.id,
        }),
      }),
    );
    expect(result.record).toBe(mockRecord);
    expect(result.already).toBe(false);
    expect(result.office).toBe('Hà Nội');
  });

  it('orphan cleanup: upsert DB fail → xoá ảnh selfie vừa upload + re-throw lỗi gốc', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: DEVICE_ID,
    });
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.attendanceRecord.upsert as jest.Mock).mockRejectedValue(new Error('DB down'));

    await expect(
      service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE),
    ).rejects.toThrow('DB down');

    // Ảnh đã upload nhưng DB fail → phải xoá ĐÚNG key vừa upload (tránh object mồ côi MinIO).
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(expect.stringContaining('attendance/1/'));
  });

  it('should throw BadRequestException khi thiếu ảnh selfie (chưa check-in)', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE });
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, undefined),
    ).rejects.toThrow(BadRequestException);
    // KHÔNG đăng ký thiết bị oan + KHÔNG upload khi thiếu selfie
    expect(prisma.employee.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
  });

  it('should return idempotent when already checked in today (KHÔNG cần selfie)', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: DEVICE_ID,
    });
    const existingRecord = { id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete' };
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(existingRecord);

    const result = await service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, undefined);

    expect(result.already).toBe(true);
    expect(prisma.attendanceRecord.upsert).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('should throw BadRequestException when IP not in any office', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE });

    await expect(
      service.checkIn(1, DEVICE_ID, makeReq('1.2.3.4'), undefined, SELFIE),
    ).rejects.toThrow(BadRequestException);
  });

  it('CHỈ chấm đúng VP được gán: office_id khớp IP → thành công', async () => {
    const OFFICE2 = { id: 2, name: 'Office B', ips: ['198.51.100.73'] };
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, OFFICE2]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE, office_id: 2 });
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue({
      id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete',
    });

    const result = await service.checkIn(1, DEVICE_ID, makeReq('198.51.100.73'), undefined, SELFIE);
    expect(result.office).toBe('Office B');
  });

  it('CHỈ chấm đúng VP được gán: IP khớp VP KHÁC (không phải VP gán) → BadRequestException', async () => {
    const OFFICE2 = { id: 2, name: 'Office B', ips: ['198.51.100.73'] };
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, OFFICE2]);
    // Gán VP id=2 (Office B) nhưng IP khớp VP id=1 (Hà Nội) → phải bị chặn
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE, office_id: 2 });

    await expect(
      service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE),
    ).rejects.toThrow(BadRequestException);
  });

  it('chưa gán VP (office_id null) → cho chấm ở mọi VP thật (fallback)', async () => {
    const OFFICE2 = { id: 2, name: 'Office B', ips: ['198.51.100.73'] };
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, OFFICE2]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE, office_id: null });
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue({
      id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete',
    });

    const result = await service.checkIn(1, DEVICE_ID, makeReq('198.51.100.73'), undefined, SELFIE);
    expect(result.office).toBe('Office B');
  });

  it('should throw BadRequestException when no employee record', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw BadRequestException when no client IP detected', async () => {
    const emptyReq = { headers: {}, socket: {} } as unknown as Request;
    await expect(
      service.checkIn(1, DEVICE_ID, emptyReq, undefined, SELFIE),
    ).rejects.toThrow(BadRequestException);
  });

  describe('demo office', () => {
    const DEMO_OFFICE = { id: 2, name: 'Demo', ips: [], is_demo: true };

    it('super_admin với IP không khớp văn phòng thật → dùng văn phòng demo, check-in thành công', async () => {
      // Chỉ có 1 văn phòng thật (IP khác) + 1 demo
      (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, DEMO_OFFICE]);
      (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
        ...EMPLOYEE,
        registered_device_id: DEVICE_ID,
      });
      const mockRecord = { id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete' };
      (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue(mockRecord);
      (prisma.employee.update as jest.Mock).mockResolvedValue({});

      // IP không khớp OFFICE_IP + isSuperAdmin=true → fallback sang văn phòng demo
      const result = await service.checkIn(1, DEVICE_ID, makeReq('9.9.9.9'), undefined, SELFIE, true);

      expect(result.already).toBe(false);
      expect(result.office).toBe('Demo');
    });

    it('super_admin qua văn phòng demo với THIẾT BỊ KHÁC đã đăng ký → KHÔNG khoá thiết bị, check-in thành công', async () => {
      // registered_device_id cũ KHÁC deviceId gửi lên — luồng demo phải BỎ QUA kiểm tra thiết bị
      (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, DEMO_OFFICE]);
      (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
        ...EMPLOYEE,
        registered_device_id: 'thiet-bi-cu-da-dang-ky',
      });
      (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue({
        id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete',
      });
      (prisma.employee.update as jest.Mock).mockResolvedValue({});

      const result = await service.checkIn(
        1, 'thiet-bi-moi-khac-hoan-toan', makeReq('9.9.9.9'), undefined, SELFIE, true,
      );

      expect(result.already).toBe(false);
      expect(result.office).toBe('Demo');
      // Luồng demo KHÔNG đăng ký lại thiết bị (không khoá vào 1 máy)
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });

    it('user thường với IP không khớp → BadRequestException kể cả khi có văn phòng demo', async () => {
      // Văn phòng demo KHÔNG được dùng cho user thường → không bypass IP check
      (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([DEMO_OFFICE]);
      (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE });

      await expect(
        service.checkIn(1, DEVICE_ID, makeReq('9.9.9.9'), undefined, SELFIE, false),
      ).rejects.toThrow(BadRequestException);
    });

    it('user thường với IP khớp văn phòng thật → check-in thành công (demo không can thiệp)', async () => {
      // Cả 2 văn phòng tồn tại; user thường khớp văn phòng thật theo IP
      (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, DEMO_OFFICE]);
      (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
        ...EMPLOYEE,
        registered_device_id: DEVICE_ID,
      });
      const mockRecord = { id: 1, user_id: 1, check_in_at: new Date(), status: 'incomplete' };
      (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue(mockRecord);
      (prisma.employee.update as jest.Mock).mockResolvedValue({});

      const result = await service.checkIn(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE, false);

      expect(result.already).toBe(false);
      expect(result.office).toBe('Hà Nội');
    });
  });
});

describe('AttendanceService — checkOut', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(async () => {
    prisma = makePrisma();
    storage = makeStorage();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('should complete check-out, upload selfie + ghi proof_key', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: DEVICE_ID,
    });
    const checkInAt = new Date(Date.now() - 9 * 3600 * 1000); // 9 hours ago
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 1,
      user_id: 1,
      check_in_at: checkInAt,
      check_out_at: null,
    });
    const updatedRecord = { id: 1, user_id: 1, check_in_at: checkInAt, check_out_at: new Date(), status: 'present' };
    (prisma.attendanceRecord.update as jest.Mock).mockResolvedValue(updatedRecord);

    const result = await service.checkOut(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE);

    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          check_out_proof_key: expect.stringContaining('attendance/1/'),
        }),
      }),
    );
    expect(result.record).toBe(updatedRecord);
    expect(result.already).toBe(false);
  });

  it('should throw BadRequestException khi thiếu ảnh selfie (chưa check-out)', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: DEVICE_ID,
    });
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 1,
      user_id: 1,
      check_in_at: new Date(Date.now() - 3600 * 1000),
      check_out_at: null,
    });

    await expect(
      service.checkOut(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, undefined),
    ).rejects.toThrow(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });

  it('should throw BadRequestException when no check-in exists', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: DEVICE_ID,
    });
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.checkOut(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE),
    ).rejects.toThrow(BadRequestException);
  });

  it('should return idempotent when already checked out (KHÔNG cần selfie)', async () => {
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: DEVICE_ID,
    });
    const record = {
      id: 1,
      user_id: 1,
      check_in_at: new Date(Date.now() - 3600 * 1000),
      check_out_at: new Date(),
    };
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(record);

    const result = await service.checkOut(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, undefined);

    expect(result.already).toBe(true);
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('checkOut CHỈ chấm đúng VP được gán: IP khớp VP khác → BadRequestException', async () => {
    const OFFICE2 = { id: 2, name: 'Office B', ips: ['198.51.100.73'] };
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, OFFICE2]);
    // Gán VP id=2 nhưng chấm ra từ IP VP id=1 (Hà Nội) → chặn
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ ...EMPLOYEE, office_id: 2 });

    await expect(
      service.checkOut(1, DEVICE_ID, makeReq(OFFICE_IP), undefined, SELFIE),
    ).rejects.toThrow(BadRequestException);
  });

  it('super_admin chấm công RA qua văn phòng demo với THIẾT BỊ KHÁC → KHÔNG khoá thiết bị, check-out thành công', async () => {
    const DEMO_OFFICE = { id: 2, name: 'Demo', ips: [], is_demo: true };
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([OFFICE, DEMO_OFFICE]);
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      ...EMPLOYEE,
      registered_device_id: 'thiet-bi-cu-da-dang-ky',
    });
    const checkInAt = new Date(Date.now() - 8 * 3600 * 1000);
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 1, user_id: 1, check_in_at: checkInAt, check_out_at: null,
    });
    const updatedRecord = { id: 1, user_id: 1, check_in_at: checkInAt, check_out_at: new Date(), status: 'present' };
    (prisma.attendanceRecord.update as jest.Mock).mockResolvedValue(updatedRecord);

    // IP không khớp văn phòng thật + isSuperAdmin=true → demo; thiết bị KHÁC nhưng KHÔNG bị chặn
    const result = await service.checkOut(
      1, 'thiet-bi-moi-khac-hoan-toan', makeReq('9.9.9.9'), undefined, SELFIE, true,
    );

    expect(result.already).toBe(false);
    expect(result.record).toBe(updatedRecord);
  });
});

describe('AttendanceService — office CRUD', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('listOffices — returns all offices ordered by name', async () => {
    const offices = [OFFICE, { id: 2, name: 'Office B', ips: ['198.51.100.73'] }];
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue(offices);

    const result = await service.listOffices();
    expect(result).toBe(offices);
  });

  it('createOffice — creates and returns office', async () => {
    const dto = { name: 'Test Office', ips: ['10.0.0.1'], description: 'Test' };
    const created = { id: 5, ...dto, is_active: true };
    (prisma.attendanceOffice.create as jest.Mock).mockResolvedValue(created);

    const result = await service.createOffice(dto);
    expect(result).toBe(created);
  });

  it('updateOffice — throws NotFoundException for unknown id', async () => {
    (prisma.attendanceOffice.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.updateOffice(999, { name: 'X' })).rejects.toThrow(NotFoundException);
  });

  it('deleteOffice — throws NotFoundException for unknown id', async () => {
    (prisma.attendanceOffice.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.deleteOffice(999)).rejects.toThrow(NotFoundException);
  });

  it('deleteOffice — deletes and returns ok', async () => {
    (prisma.attendanceOffice.findUnique as jest.Mock).mockResolvedValue(OFFICE);
    (prisma.attendanceOffice.delete as jest.Mock).mockResolvedValue(OFFICE);

    const result = await service.deleteOffice(1);
    expect(result).toEqual({ ok: true });
  });
});

describe('AttendanceService — resetDevice', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('should reset device and return ok', async () => {
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({
      id: 10,
      registered_device_id: DEVICE_ID,
    });
    (prisma.employee.update as jest.Mock).mockResolvedValue({});

    const result = await service.resetDevice(1);
    expect(prisma.employee.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { registered_device_id: null, device_registered_at: null },
      }),
    );
    expect(result).toEqual({ ok: true, user_id: 1 });
  });

  it('should throw NotFoundException when employee not found', async () => {
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.resetDevice(999)).rejects.toThrow(NotFoundException);
  });
});

describe('AttendanceService — deleteRecord', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('deletes record and returns ok so the employee can re-check-in', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 7,
      user_id: 42,
      work_date: new Date('2026-06-16T00:00:00Z'),
    });
    (prisma.attendanceRecord.delete as jest.Mock).mockResolvedValue({});

    const result = await service.deleteRecord(7, 1, 'all');

    expect(prisma.attendanceRecord.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(result).toEqual({ ok: true, id: 7, user_id: 42 });
  });

  it('throws NotFoundException when record does not exist', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.deleteRecord(999, 1, 'all')).rejects.toThrow(NotFoundException);
    expect(prisma.attendanceRecord.delete).not.toHaveBeenCalled();
  });

  it('scope team: bản ghi của user ngoài phạm vi → 404, KHÔNG xoá', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 7,
      user_id: 42,
      work_date: new Date('2026-06-16T00:00:00Z'),
    });
    await expect(service.deleteRecord(7, 1, [1, 2])).rejects.toThrow(NotFoundException);
    expect(prisma.attendanceRecord.delete).not.toHaveBeenCalled();
  });

  it('scope team: patchRecord ngoài phạm vi → 404, KHÔNG update', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({ id: 7, user_id: 42 });
    await expect(service.patchRecord(7, {} as never, [1, 2])).rejects.toThrow(NotFoundException);
    expect(prisma.attendanceRecord.update).not.toHaveBeenCalled();
  });
});

describe('AttendanceService — IDOR guard for getRecordById', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('non-super_admin cannot view another user record (404)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 5,
      user_id: 99,
    });
    await expect(service.getRecordById(5, 1, [1])).rejects.toThrow(NotFoundException);
  });

  it('super_admin can view any record', async () => {
    const record = { id: 5, user_id: 99 };
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(record);
    const result = await service.getRecordById(5, 1, 'all');
    // getRecordById giờ trả bản sao spread + breakdown đi muộn → so field, KHÔNG so reference.
    expect(result).toMatchObject(record);
  });
});

describe('AttendanceService — streamProof (ảnh selfie, IDOR)', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(async () => {
    prisma = makePrisma();
    storage = makeStorage();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('throws NotFoundException khi không tìm thấy bản ghi', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.streamProof(5, 'in', 1, [1])).rejects.toThrow(NotFoundException);
  });

  it('non-super_admin KHÔNG xem được ảnh của bản ghi người khác (404)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      user_id: 99,
      check_in_proof_key: 'attendance/99/2026-06-16/in_1.jpg',
      check_out_proof_key: null,
    });
    await expect(service.streamProof(5, 'in', 1, [1])).rejects.toThrow(NotFoundException);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('throws NotFoundException khi slot chưa có ảnh (proof_key null)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      user_id: 1,
      check_in_proof_key: null,
      check_out_proof_key: null,
    });
    await expect(service.streamProof(5, 'in', 1, [1])).rejects.toThrow(NotFoundException);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('owner xem được ảnh của chính mình → stream', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      user_id: 1,
      check_in_proof_key: 'attendance/1/2026-06-16/in_1.jpg',
      check_out_proof_key: null,
    });
    (storage.getObjectStream as jest.Mock).mockResolvedValue({
      body: {} as Readable,
      contentType: 'image/jpeg',
      contentLength: 100,
    });
    const result = await service.streamProof(5, 'in', 1, [1]);
    expect(storage.getObjectStream).toHaveBeenCalledWith('attendance/1/2026-06-16/in_1.jpg');
    expect(result.contentType).toBe('image/jpeg');
  });

  it('super_admin xem được ảnh bản ghi người khác (slot out)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      user_id: 99,
      check_in_proof_key: null,
      check_out_proof_key: 'attendance/99/2026-06-16/out_2.jpg',
    });
    (storage.getObjectStream as jest.Mock).mockResolvedValue({
      body: {} as Readable,
      contentType: 'image/png',
      contentLength: 50,
    });
    const result = await service.streamProof(5, 'out', 1, 'all');
    expect(storage.getObjectStream).toHaveBeenCalledWith('attendance/99/2026-06-16/out_2.jpg');
    expect(result.contentType).toBe('image/png');
  });
});

// ============================================================
// getRecordById TÍNH LẠI late_minutes từ giờ chấm + mốc cấu hình (late_after).
// ============================================================
describe('AttendanceService — getRecordById late_minutes recompute', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  // 17/06/2026 là Thứ 4. 09:00 giờ VN = 02:00 UTC → muộn 50p so mốc 08:10 (490p).
  const WORK_DATE = new Date(Date.UTC(2026, 5, 17)); // UTC-midnight ngày VN 17/06
  const checkInVn = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    // VN = UTC+7 → trừ 7h ra UTC
    return new Date(Date.UTC(2026, 5, 17, h - 7, m, 0));
  };
  const baseRecord = (over: Record<string, unknown> = {}) => ({
    id: 1,
    user_id: 1,
    work_date: WORK_DATE,
    check_in_at: checkInVn('09:00'),
    check_out_at: null,
    total_hours: null,
    late_minutes: 0,
    status: 'incomplete',
    user: { id: 1, full_name: 'A', email: 'a@x.vn', employee: { position: 'NV' } },
    ...over,
  });

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('vào 09:00 (sau mốc 08:10) → late_minutes = 50', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(baseRecord());
    const r = (await service.getRecordById(1, 1, 'all')) as unknown as Record<string, number>;
    expect(r.late_minutes).toBe(50);
  });

  it('vào 08:15 (muộn 5p) → late_minutes = 5', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(
      baseRecord({ check_in_at: checkInVn('08:15') }),
    );
    const r = (await service.getRecordById(1, 1, 'all')) as unknown as Record<string, number>;
    expect(r.late_minutes).toBe(5);
  });

  it('vào 08:00 (đúng giờ) → late_minutes = 0', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(
      baseRecord({ check_in_at: checkInVn('08:00') }),
    );
    const r = (await service.getRecordById(1, 1, 'all')) as unknown as Record<string, number>;
    expect(r.late_minutes).toBe(0);
  });

  it('chưa check-in → late_minutes = 0', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(
      baseRecord({ check_in_at: null }),
    );
    const r = (await service.getRecordById(1, 1, 'all')) as unknown as Record<string, number>;
    expect(r.late_minutes).toBe(0);
  });

  it('IDOR: non-admin xem bản ghi người khác → NotFoundException (404)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(
      baseRecord({ user_id: 999 }),
    );
    await expect(service.getRecordById(1, 1, [1])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ============================================================
// tự trừ giờ nghỉ trưa khỏi total_hours (qua patchRecord)
// ============================================================
describe('AttendanceService — lunch break deduction', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  // Ca làm 08:00–17:00, muộn sau 08:10, nghỉ trưa 12:00–13:00 (giờ VN).
  const SHIFT_WITH_LUNCH = {
    value: JSON.stringify({
      work_start: '08:00',
      work_end: '17:00',
      late_after: '08:10',
      lunch_start: '12:00',
      lunch_end: '13:00',
    }),
  };

  beforeEach(async () => {
    prisma = makePrisma();
    (prisma.setting.findUnique as jest.Mock).mockResolvedValue(SHIFT_WITH_LUNCH);
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 1,
      user_id: 1,
      check_in_at: null,
      check_out_at: null,
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  // 08:00 VN = 01:00 UTC; 18:00 VN = 11:00 UTC
  it('khoảng làm bao trọn giờ nghỉ trưa → trừ đủ 1 giờ (10h gộp → 9h)', async () => {
    await service.patchRecord(1, {
      check_in_at: '2026-06-17T01:00:00.000Z',
      check_out_at: '2026-06-17T11:00:00.000Z',
    } as never, 'all');
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ total_hours: 9 }) }),
    );
  });

  // 13:30 VN = 06:30 UTC; 17:00 VN = 10:00 UTC — KHÔNG chạm giờ nghỉ trưa
  it('khoảng làm không chạm giờ nghỉ trưa → không trừ (3.5h)', async () => {
    await service.patchRecord(1, {
      check_in_at: '2026-06-17T06:30:00.000Z',
      check_out_at: '2026-06-17T10:00:00.000Z',
    } as never, 'all');
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ total_hours: 3.5 }) }),
    );
  });

  // 12:30 VN = 05:30 UTC; 14:00 VN = 07:00 UTC — chỉ chồng 30p (12:30–13:00)
  it('khoảng làm chồng một phần giờ nghỉ trưa → trừ đúng phần chồng (1.5h gộp → 1.0h)', async () => {
    await service.patchRecord(1, {
      check_in_at: '2026-06-17T05:30:00.000Z',
      check_out_at: '2026-06-17T07:00:00.000Z',
    } as never, 'all');
    expect(prisma.attendanceRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ total_hours: 1 }) }),
    );
  });

  it('updateShiftConfig CHẶN cửa sổ nghỉ trưa đảo ngược (lunch_end <= lunch_start) → BadRequestException', async () => {
    await expect(
      service.updateShiftConfig(
        {
          work_start: '08:00',
          work_end: '17:00',
          late_after: '08:10',
          lunch_start: '13:00',
          lunch_end: '12:00',
        } as never,
        1,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });
});

// ============================================================
// thống kê chấm công tổng hợp (getAttendanceStats)
// ============================================================
describe('AttendanceService — getAttendanceStats', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  // KHÔNG lọc → total = prisma.user.count (giữ hành vi cũ); $queryRaw order:
  //   daily(1), distinct(2), team(3), deptRows(4), heads(5).
  // CÓ lọc → total cũng là $queryRaw (test riêng bên dưới).
  // (Danh sách NV vắng tách sang endpoint /absent riêng — KHÔNG còn trong /stats.)
  it('không lọc: total=user.count (giữ hành vi cũ) + summary/daily/team đúng', async () => {
    (prisma.user.count as jest.Mock).mockResolvedValue(50);
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        { day: '2026-06-16', checked_in: 10, checked_out: 9, complete: 9, late: 3, on_time: 7, late_minutes: 45 },
        { day: '2026-06-17', checked_in: 8, checked_out: 8, complete: 8, late: 1, on_time: 7, late_minutes: 5 },
      ]) // daily
      .mockResolvedValueOnce([{ count: 12 }]) // distinct
      .mockResolvedValueOnce([
        {
          team_id: 5,
          team_name: 'Team A',
          headcount: 10,
          checked_in_people: 8,
          present_people: 6,
          late_people: 2,
          total_late_minutes: 30,
        },
      ]) // team
      .mockResolvedValueOnce([]) // deptRows
      .mockResolvedValueOnce([]); // heads

    const res = await service.getAttendanceStats({
      date_from: '2026-06-16',
      date_to: '2026-06-17',
    });

    expect(prisma.user.count).toHaveBeenCalledTimes(1);

    expect(res.total_employees).toBe(50);
    expect(res.distinct_checked_in).toBe(12);
    expect(res.not_checked_in).toBe(38);
    expect(res.summary).toEqual({
      checked_in: 18,
      checked_out: 17,
      complete: 17,
      on_time: 14,
      late: 4,
      total_late_minutes: 50,
    });
    expect(res.daily).toHaveLength(2);
    expect(res.daily[0]).toEqual({
      date: '2026-06-16',
      checked_in: 10,
      on_time: 7,
      late: 3,
    });
    expect(res.by_team).toHaveLength(1);
    expect(res.by_team[0]).toMatchObject({
      team_name: 'Team A',
      headcount: 10,
      checked_in_people: 8,
      insufficient_people: 2, // 8 − 6
      absent_people: 2, // 10 − 8
      attendance_rate: 80, // 8/10
    });
    expect(res.date_from).toBe('2026-06-16');
    expect(res.date_to).toBe('2026-06-17');
  });

  it('mặc định khoảng = tháng hiện tại; rỗng dữ liệu → 0/0/0', async () => {
    (prisma.user.count as jest.Mock).mockResolvedValue(0);
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]); // mọi query rỗng

    const res = await service.getAttendanceStats({});

    expect(res.total_employees).toBe(0);
    expect(res.distinct_checked_in).toBe(0);
    expect(res.not_checked_in).toBe(0);
    expect(res.summary.checked_in).toBe(0);
    expect(res.daily).toEqual([]);
    expect(res.by_team).toEqual([]);
    expect(res.by_department).toEqual([]);
    // Mặc định date_from = ngày 1 của tháng hiện tại (giờ VN)
    expect(res.date_from.endsWith('-01')).toBe(true);
  });

  it('CÓ lọc: total dùng $queryRaw roster (KHÔNG user.count) — $queryRaw order total(1)..', async () => {
    // hasFilter=true → total là $queryRaw đầu tiên; user.count KHÔNG được gọi.
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ count: 9 }]) // total (roster filtered)
      .mockResolvedValueOnce([]) // daily
      .mockResolvedValueOnce([{ count: 4 }]) // distinct
      .mockResolvedValueOnce([]) // team
      .mockResolvedValueOnce([]) // deptRows
      .mockResolvedValueOnce([]) // heads
      .mockResolvedValueOnce([]); // early_leave allowedUserIds (roster filtered → rỗng → bỏ qua)

    const res = await service.getAttendanceStats({ department: ['KD'] });

    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(res.total_employees).toBe(9);
    expect(res.distinct_checked_in).toBe(4);
    expect(res.not_checked_in).toBe(5);
  });

  // per-day join (dailyPromise, GROUP BY ar.work_date) dùng REF=ar.work_date
  // (cột SQL, KHÔNG tham số hoá) → mỗi bản ghi chấm công được xét carve-back theo ĐÚNG ngày của
  // NÓ: bản ghi trước ngày nghỉ vẫn được đếm; bản ghi từ ngày nghỉ trở đi bị loại. Test xác nhận
  // SQL fragment sinh ra dùng cột `ar.work_date` làm mốc so sánh (không phải tham số ngày cố định).
  it('getAttendanceStats (có lọc → roster): carve-back per-day dùng REF=ar.work_date (giữ lịch sử trước ngày nghỉ)', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await service.getAttendanceStats({ department: ['KD'] });

    // dailyPromise là lệnh $queryRaw thứ 2 trong nhánh useRoster (sau totalPromise).
    const dailyCallArgs = (prisma.$queryRaw as jest.Mock).mock.calls[1] as unknown[];
    const cond = dailyCallArgs.find(
      (a) =>
        a != null &&
        typeof (a as { sql?: unknown }).sql === 'string' &&
        (a as { sql: string }).sql.includes('resigned_at'),
    ) as { sql: string; values: unknown[] } | undefined;

    expect(cond).toBeDefined();
    expect(cond!.sql).toContain("e.status = 'active'");
    expect(cond!.sql).toContain("e.status = 'resigned'");
    // REF = cột ar.work_date (per-day) — KHÔNG phải placeholder tham số.
    expect(cond!.sql).toContain('> ar.work_date');
    expect(cond!.values).toEqual([]);
  });
});

// ============================================================
// Thống kê theo Team / Phòng ban + tuỳ chọn bộ lọc
// ============================================================
describe('AttendanceService — getStatsByTeam / getStatsByDepartment / filters', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('getStatsByTeam derive Chưa đủ công / Vắng / Tỷ lệ %', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      {
        team_id: 3,
        team_name: 'Team B',
        headcount: 8,
        checked_in_people: 5,
        present_people: 3,
        late_people: 1,
        total_late_minutes: 12,
      },
    ]);

    const rows = await service.getStatsByTeam({});

    expect(rows[0]).toMatchObject({
      insufficient_people: 2, // 5 − 3
      absent_people: 3, // 8 − 5
      attendance_rate: 62.5, // 5/8
    });
  });

  // NV nghỉ việc (employees.resigned_at) chỉ bị loại khỏi roster KỂ TỪ ngày nghỉ;
  // dữ liệu/thống kê TRƯỚC ngày nghỉ vẫn giữ. Roster theo khoảng [from,to] (getStatsByTeam) →
  // REF = date_from (NV nghỉ SAU đầu kỳ vẫn có công trong kỳ → vẫn được đếm).
  it('getStatsByTeam: SQL roster carve-back NV nghỉ việc dùng REF=date_from', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    await service.getStatsByTeam({ date_from: '2026-07-01', date_to: '2026-07-31' });

    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0] as unknown[];
    const cond = args.find(
      (a) =>
        a != null &&
        typeof (a as { sql?: unknown }).sql === 'string' &&
        (a as { sql: string }).sql.includes('resigned_at'),
    ) as { sql: string; values: unknown[] } | undefined;

    expect(cond).toBeDefined();
    // Nhánh active GIỮ NGUYÊN (on_leave/probation/... vẫn bị loại như cũ).
    expect(cond!.sql).toContain("e.status = 'active'");
    // Carve-back: resigned NHƯNG resigned_at > mốc tham chiếu (đầu kỳ) → vẫn tính.
    expect(cond!.sql).toContain("e.status = 'resigned'");
    expect(cond!.sql).toContain('resigned_at IS NOT NULL');
    expect(cond!.sql).toContain("AT TIME ZONE 'Asia/Ho_Chi_Minh'");
    // REF tham số hoá = date_from (KHÔNG nội suy chuỗi trần).
    expect(cond!.values).toContain('2026-07-01');
  });

  it('getStatsByDepartment chọn Trưởng phòng ưu tiên "trưởng phòng" (rank 1)', async () => {
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        {
          department: 'Kinh doanh',
          headcount: 6,
          checked_in_people: 6,
          present_people: 6,
          late_people: 0,
          total_late_minutes: 0,
        },
      ]) // deptRows
      .mockResolvedValueOnce([
        { department: 'Kinh doanh', head_name: 'Trưởng Phòng KD', head_rank: 1 },
        { department: 'Kinh doanh', head_name: 'Trưởng nhóm', head_rank: 2 },
      ]); // heads (ORDER BY head_rank → rank 1 trước)

    const rows = await service.getStatsByDepartment({});

    expect(rows[0]).toMatchObject({
      department: 'Kinh doanh',
      head_name: 'Trưởng Phòng KD',
      absent_people: 0,
      attendance_rate: 100,
    });
  });

  it('getStatsFilterOptions trả 3 nhóm tuỳ chọn', async () => {
    // Thứ tự gọi $queryRaw: (1) teams (teamsQuery đánh giá TRƯỚC Promise.all), (2) departments, (3) offices.
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ id: 7, name: 'Quản lý A' }]) // teams (bảng teams chính thức)
      .mockResolvedValueOnce([{ department: 'KD' }, { department: 'MKT' }]) // departments
      .mockResolvedValueOnce([{ id: 1, name: 'Văn phòng HN' }]); // offices

    const res = await service.getStatsFilterOptions();

    expect(res.departments).toEqual(['KD', 'MKT']);
    // Team chính thức + option ảo "Chưa có team" (sentinel -1) luôn được append.
    expect(res.teams).toEqual([
      { id: 7, name: 'Quản lý A' },
      { id: -1, name: 'Chưa có team' },
    ]);
    expect(res.offices).toEqual([{ id: 1, name: 'Văn phòng HN' }]);
  });
});

// ============================================================
// RBAC scope `attendance.view` — resolveStatsScope() ủy quyền cho ScopeService

// ============================================================
describe('AttendanceService — resolveStatsScope (RBAC quyền + phạm vi)', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;
  let scope: { ownerIds: jest.Mock };

  beforeEach(async () => {
    prisma = makePrisma();
    scope = { ownerIds: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it("scope 'all' (vd Quản trị / vai trò được cấp attendance.view=all) → null (xem tất cả)", async () => {
    scope.ownerIds.mockResolvedValue('all');
    expect(await service.resolveStatsScope(authUser(1))).toBeNull();
  });

  it("scope hẹp (own/team/subtree) → trả nguyên mảng user id từ ScopeService", async () => {
    scope.ownerIds.mockResolvedValue([10, 20, 21]);
    const result = await service.resolveStatsScope(authUser(10));
    expect(result).toEqual([10, 20, 21]);
    expect(scope.ownerIds).toHaveBeenCalledWith(authUser(10), 'attendance.view');
  });

  it('không có quyền attendance.view (ownerIds trả null) → null (an toàn, controller đã gác @Can trước)', async () => {
    scope.ownerIds.mockResolvedValue(null);
    expect(await service.resolveStatsScope(authUser(99))).toBeNull();
  });

  it('getStatsByTeam: scope ids nhúng vào WHERE (e.user_id IN ...)', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    await service.getStatsByTeam({}, [10, 20]);
    // $queryRaw nhận empFilter (Prisma.Sql) — values chứa scope ids.
    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0] as unknown[];
    // Gộp values của MỌI Prisma.Sql nhúng (RESOLVED_TEAM_ID_SQL values=[] đứng trước empFilter).
    const allValues = args
      .filter((a) => a != null && Array.isArray((a as { values?: unknown[] }).values))
      .flatMap((a) => (a as { values: unknown[] }).values);
    expect(allValues).toEqual(expect.arrayContaining([10, 20]));
  });

  it('getAttendanceStats: CÓ scope (no filter) → roster (KHÔNG dùng user.count)', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    await service.getAttendanceStats({}, [10, 20]);
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('getAbsentEmployees: scope ids nhúng vào WHERE', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    await service.getAbsentEmployees('2026-06-23', 'team', 'asc', [10, 20]);
    const args = (prisma.$queryRaw as jest.Mock).mock.calls[0] as unknown[];
    const sql = args.find(
      (a) => a != null && Array.isArray((a as { values?: unknown[] }).values) &&
        (a as { values: unknown[] }).values.includes(10),
    ) as { values: unknown[] };
    expect(sql.values).toEqual(expect.arrayContaining([10, 20]));
  });
});

// ============================================================
// resolveOwnerIds + scope THẬT trên sổ chấm công/chi tiết/ảnh selfie/export
// thường — actor scope `team` chỉ thấy bản ghi trong team: dùng đúng mảng owner id do
// ScopeService trả về.
// ============================================================
describe('AttendanceService — resolveOwnerIds + scope thật', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;
  let scope: { ownerIds: jest.Mock };

  beforeEach(async () => {
    prisma = makePrisma();
    scope = { ownerIds: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: scope },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('resolveOwnerIds ủy quyền nguyên vẹn cho ScopeService.ownerIds(user, perm)', async () => {
    scope.ownerIds.mockResolvedValue([2, 3]);
    const result = await service.resolveOwnerIds(authUser(2), 'attendance.view');
    expect(result).toEqual([2, 3]);
    expect(scope.ownerIds).toHaveBeenCalledWith(authUser(2), 'attendance.view');
  });

  it("resolveOwnerIds: ownerIds trả null (không có quyền, không nên xảy ra vì @Can đã gác) → fail-closed '[]', KHÔNG 'all'", async () => {
    scope.ownerIds.mockResolvedValue(null);
    expect(await service.resolveOwnerIds(authUser(1), 'attendance.export')).toEqual([]);
  });

  it("getRecordById: scope team [2,3] KHÔNG thấy bản ghi user_id=99 ngoài team → 404 (KHÔNG còn xem được như isAdmin=true cũ)", async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({ id: 5, user_id: 99 });
    await expect(service.getRecordById(5, 2, [2, 3])).rejects.toThrow(NotFoundException);
  });

  it('getRecordById: scope team [2,3] THẤY được bản ghi user_id=3 (đồng nghiệp trong team)', async () => {
    const record = { id: 5, user_id: 3 };
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(record);
    const result = await service.getRecordById(5, 2, [2, 3]);
    expect(result).toMatchObject(record);
  });

  it("streamProof: scope team [2,3] KHÔNG xem được ảnh selfie user_id=99 ngoài team → 404", async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      user_id: 99,
      check_in_proof_key: 'attendance/99/2026-06-16/in_1.jpg',
      check_out_proof_key: null,
    });
    await expect(service.streamProof(5, 'in', 2, [2, 3])).rejects.toThrow(NotFoundException);
  });

  it('listRecords: scope team [2,3] → where.user_id giao (IN) đúng 2 người, KHÔNG company-wide', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(0);
    await service.listRecords(2, [2, 3], {} as never);
    const where = (prisma.attendanceRecord.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.user_id).toEqual({ in: [2, 3] });
  });

  it('listRecords: scope team [2,3] + dto.user_id=99 (ngoài team) → giao rỗng (-1), KHÔNG trả dữ liệu ngoài scope', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(0);
    await service.listRecords(2, [2, 3], { user_id: 99 } as never);
    const where = (prisma.attendanceRecord.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.user_id).toBe(-1);
  });

  it("listRecords: scope 'all' → KHÔNG áp filter user_id khi dto không chỉ định", async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(0);
    await service.listRecords(2, 'all', {} as never);
    const where = (prisma.attendanceRecord.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.user_id).toBeUndefined();
  });
});

// ============================================================
// Danh sách NV vắng (chưa chấm vào lẫn ra) — getAbsentEmployees
// ============================================================
describe('AttendanceService — getAbsentEmployees', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('trả danh sách NV vắng từ raw query (giữ nguyên null department/position)', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([
      { user_id: 7, employee_code: 'NV0007', full_name: 'Lê C', email: 'c@x.vn', position: null, department: null },
      { user_id: 8, employee_code: 'MKT-01', full_name: 'Phạm D', email: null, position: 'MKT', department: 'Marketing' },
    ]);

    const res = await service.getAbsentEmployees('2026-06-20');

    expect(res).toHaveLength(2);
    expect(res[0].user_id).toBe(7);
    expect(res[0].department).toBeNull();
    expect(res[1].employee_code).toBe('MKT-01');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('không có NV vắng → trả mảng rỗng', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
    const res = await service.getAbsentEmployees('2026-06-20');
    expect(res).toEqual([]);
  });
});

// ============================================================
// Recompute status khi hiển thị + ngưỡng cấu hình + nghỉ phép = full 8h
// ============================================================
describe('AttendanceService — recompute status + threshold config + leave 8h', () => {
  async function buildService(prisma: PrismaService): Promise<AttendanceService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    return module.get(AttendanceService);
  }
  const WD = new Date(Date.UTC(2026, 5, 17)); // 17/06/2026 (Thứ 4)
  const vn = (h: number, m: number) => new Date(Date.UTC(2026, 5, 17, h - 7, m)); // giờ VN → UTC
  const userRel = { id: 1, full_name: 'A', email: null, employee: { position: 'NV' } };

  it('listRecords: 0h lưu status="half_day" (stale) → TÍNH LẠI thành "review"', async () => {
    const prisma = makePrisma();
    const service = await buildService(prisma);
    const t = vn(18, 48); // vào = ra 18:48 → 0h
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 91, user_id: 1, work_date: WD, check_in_at: t, check_out_at: t, total_hours: 0, status: 'half_day', late_minutes: 638, user: userRel },
    ]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(1);
    const res = await service.listRecords(1, 'all', {} as never);
    expect(res.data[0].status).toBe('review');
  });

  it('listRecords: 2.5h (>=1, <4) → "insufficient" (Chưa đủ nửa ngày)', async () => {
    const prisma = makePrisma();
    const service = await buildService(prisma);
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 1, user_id: 1, work_date: WD, check_in_at: vn(8, 0), check_out_at: vn(10, 30), total_hours: 2.5, status: 'present', late_minutes: 0, user: userRel },
    ]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(1);
    const res = await service.listRecords(1, 'all', {} as never);
    expect(res.data[0].status).toBe('insufficient');
  });

  it('listRecords: GIỮ NGUYÊN status "leave" (không suy lại từ giờ chấm)', async () => {
    const prisma = makePrisma();
    const service = await buildService(prisma);
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 1, user_id: 1, work_date: WD, check_in_at: vn(8, 0), check_out_at: vn(17, 30), total_hours: 8, status: 'leave', late_minutes: 0, user: userRel },
    ]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(1);
    const res = await service.listRecords(1, 'all', {} as never);
    expect(res.data[0].status).toBe('leave');
  });

  it('listRecords: ĐI MUỘN (vào 09:00) nhưng đủ 8h → "present" (đủ công), KHÔNG còn "late"', async () => {
    const prisma = makePrisma();
    const service = await buildService(prisma);
    // Vào 09:00 (sau mốc muộn 08:10) → ra 19:00 = 10h gross − 2h nghỉ trưa (11:30–13:30) = 8h net.
    // Trạng thái CHỈ theo giờ → đủ 8h = đủ công; muộn → cột Ghi chú (late_minutes).
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 1, user_id: 1, work_date: WD, check_in_at: vn(9, 0), check_out_at: vn(19, 0), total_hours: 8, status: 'late', late_minutes: 50, user: userRel },
    ]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(1);
    const res = await service.listRecords(1, 'all', {} as never);
    expect(res.data[0].status).toBe('present');
    expect(res.data[0].status).not.toBe('late');
  });

  it('updateShiftConfig CHẶN full_day_min_hours <= review_max_hours → BadRequestException', async () => {
    const prisma = makePrisma();
    const service = await buildService(prisma);
    await expect(
      service.updateShiftConfig(
        { work_start: '08:00', work_end: '17:00', late_after: '08:10', lunch_start: '11:30', lunch_end: '13:30', review_max_hours: 8, full_day_min_hours: 4 } as never,
        1,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it('approveRequest nghỉ phép → upsert total_hours=8 + status="leave" + giờ 08:00–17:30', async () => {
    const leaveReq = {
      id: 1, user_id: 5, work_date: new Date(Date.UTC(2026, 5, 15)), type: 'leave',
      requested_check_in: null, requested_check_out: null, reason: 'nghỉ', status: 'pending',
      reviewed_by: null, reviewed_at: null, review_note: null, created_at: new Date(),
    };
    const prisma = makePrisma({
      attendanceRequest: {
        findUnique: jest.fn().mockResolvedValue(leaveReq),
        update: jest.fn().mockResolvedValue({ ...leaveReq, status: 'approved', reviewed_by: 9, reviewed_at: new Date() }),
      },
      user: { count: jest.fn(), findUnique: jest.fn().mockResolvedValue({ full_name: 'X', email: null }) },
      $transaction: jest.fn(),
    });
    (prisma.$transaction as jest.Mock).mockImplementation((cb: (tx: PrismaService) => unknown) => cb(prisma));
    (prisma.employee.findUnique as jest.Mock).mockResolvedValue({ id: 50 });
    (prisma.attendanceRecord.upsert as jest.Mock).mockResolvedValue({});
    const service = await buildService(prisma);

    await service.approveRequest(1, 9, 'all');

    expect(prisma.attendanceRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ total_hours: 8, status: 'leave', late_minutes: 0, check_in_at: expect.any(Date), check_out_at: expect.any(Date) }),
      }),
    );
  });
});

// ============================================================
// regression — total_hours HIỂN THỊ phải TÍNH LẠI (trừ nghỉ trưa), KHÔNG tin giá trị
// lưu DB (stale). Bản ghi chấm RA trước khi bật trừ nghỉ trưa lưu total_hours thô (vd 4.24h)
// → sổ chấm công / popup chi tiết phải hiện 3.78h (đã trừ 28' nghỉ trưa 11:30–11:58).
// Mirror displayStatus: leave/maternity GIỮ NGUYÊN total_hours lưu DB (do duyệt đơn set).
// ============================================================
describe('AttendanceService — total_hours recompute on display ( regression)', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  // 18/06/2026. VN = UTC+7 → trừ 7h ra UTC.
  const WD = new Date(Date.UTC(2026, 5, 18));
  const vn = (h: number, m: number) => new Date(Date.UTC(2026, 5, 18, h - 7, m, 0));
  const userRel = { id: 1, full_name: 'Nhân viên Test', email: null, employee: { position: 'NV' } };

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
    // Kịch bản các test dưới đây giả định cửa sổ nghỉ trưa 11:30–13:30 (ra 11:58 chồng 28').
    // Mock tường minh Setting để KHÔNG phụ thuộc default.
    (prisma.setting.findUnique as jest.Mock).mockResolvedValue({
      value: JSON.stringify({
        work_start: '08:00', work_end: '17:00', late_after: '08:10',
        lunch_start: '11:30', lunch_end: '13:30',
        review_max_hours: 1, half_day_min_hours: 4, full_day_min_hours: 8,
      }),
    });
  });

  // Bản ghi của Nhân viên Test: vào 07:43, ra 11:58, total_hours lưu DB = 4.24 (thô, chưa trừ nghỉ trưa).
  const staleRecord = (over: Record<string, unknown> = {}) => ({
    id: 42,
    user_id: 1,
    work_date: WD,
    check_in_at: vn(7, 43),
    check_out_at: vn(11, 58),
    total_hours: 4.24,
    status: 'half_day',
    late_minutes: 0,
    user: userRel,
    ...over,
  });

  it('getRecordById: total_hours lưu 4.24 (thô) → TÍNH LẠI = 3.78 (trừ 28 phút nghỉ trưa 11:30–11:58)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(staleRecord());
    const r = (await service.getRecordById(42, 1, 'all')) as unknown as { total_hours: number };
    expect(r.total_hours).toBe(3.78);
  });

  it('listRecords: total_hours lưu 4.24 (thô) → TÍNH LẠI = 3.78', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([staleRecord()]);
    (prisma.attendanceRecord.count as jest.Mock).mockResolvedValue(1);
    const res = await service.listRecords(1, 'all', {} as never);
    expect((res.data[0] as unknown as { total_hours: number }).total_hours).toBe(3.78);
  });

  it('GIỮ NGUYÊN total_hours nghỉ phép (leave) — KHÔNG suy lại từ giờ tượng trưng 08:00–17:30', async () => {
    // leave: check_in/out tượng trưng 08:00–17:30, total_hours=8 do duyệt đơn set.
    // Recompute mù → 9.5h gross − 2h nghỉ trưa = 7.5h (SAI). Phải giữ 8.
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue(
      staleRecord({ check_in_at: vn(8, 0), check_out_at: vn(17, 30), total_hours: 8, status: 'leave' }),
    );
    const r = (await service.getRecordById(42, 1, 'all')) as unknown as { total_hours: number };
    expect(r.total_hours).toBe(8);
  });

  it('getWorkdaysMatrix (bảng công tháng): nghỉ phép GIỮ 8h; ngày thường tính lại trừ nghỉ trưa', async () => {
    const rel = (name: string) => ({
      id: 0, full_name: name, email: null,
      employee: { position: 'NV', employee_code: null, department: null },
    });
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      // Nghỉ phép: mốc 08:00–17:30 tượng trưng, lưu 8h → phải GIỮ 8 (recompute mù sẽ ra 7.5).
      { id: 1, user_id: 7, work_date: WD, check_in_at: vn(8, 0), check_out_at: vn(17, 30), total_hours: 8, status: 'leave', late_minutes: 0, user: rel('Nghỉ Phép') },
      // Ngày thường: 07:43–11:58 lưu thô 4.24 → tính lại 3.78 (trừ 28' nghỉ trưa).
      { id: 2, user_id: 8, work_date: WD, check_in_at: vn(7, 43), check_out_at: vn(11, 58), total_hours: 4.24, status: 'half_day', late_minutes: 0, user: rel('Ngày Thường') },
    ]);
    const res = (await service.getWorkdaysMatrix({ date_from: '2026-06-18', date_to: '2026-06-18' } as never, 'all')) as unknown as {
      rows: Array<{ user_id: number; total_hours: number; cells: Record<number, { hours: number | null }> }>;
    };
    const leaveRow = res.rows.find((r) => r.user_id === 7)!;
    const normalRow = res.rows.find((r) => r.user_id === 8)!;
    expect(leaveRow.total_hours).toBe(8);
    expect(leaveRow.cells[18].hours).toBe(8);
    expect(normalRow.total_hours).toBe(3.78);
    expect(normalRow.cells[18].hours).toBe(3.78);
  });
});

// ============================================================
// Bù công khi duyệt đơn về sớm
// ============================================================
describe('AttendanceService — overlay đơn về sớm (bù công)', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  const WD = new Date(Date.UTC(2026, 5, 18));
  const WD2 = new Date(Date.UTC(2026, 5, 19));
  const vn = (d: Date, h: number, m: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 7, m));
  // Tắt nghỉ trưa (lunch_start == lunch_end → overlap 0) để số giờ tính sạch.
  const NO_LUNCH_CFG = JSON.stringify({
    work_start: '08:00', work_end: '17:00', late_after: '08:10',
    lunch_start: '00:00', lunch_end: '00:00',
    review_max_hours: 1, half_day_min_hours: 4, full_day_min_hours: 8,
  });
  const rel = (name: string) => ({
    id: 0, full_name: name, email: null,
    employee: { position: 'NV', employee_code: null, department: null },
  });

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
    (prisma.setting.findUnique as jest.Mock).mockResolvedValue({ value: NO_LUNCH_CFG });
  });

  it('getWorkdaysMatrix: ngày half_day + đơn DUYỆT → bù thành đủ công (after = thực tế + 0.5)', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      // user 1: 08:00–12:00 = 4h → half_day (4–8h)
      { id: 1, user_id: 1, work_date: WD, check_in_at: vn(WD, 8, 0), check_out_at: vn(WD, 12, 0), total_hours: 4, status: 'half_day', late_minutes: 0, user: rel('Nửa Ngày') },
      // user 2: 08:00–11:00 = 3h → insufficient (<4h, nghiêm trọng)
      { id: 2, user_id: 2, work_date: WD, check_in_at: vn(WD, 8, 0), check_out_at: vn(WD, 11, 0), total_hours: 3, status: 'insufficient', late_minutes: 0, user: rel('Thiếu Nghiêm Trọng') },
    ]);
    (prisma.attendanceRequest.findMany as jest.Mock).mockResolvedValue([
      { user_id: 1, work_date: WD, status: 'approved' },
      { user_id: 2, work_date: WD, status: 'approved' },
    ]);

    const res = (await service.getWorkdaysMatrix({
      date_from: '2026-06-18', date_to: '2026-06-18',
    } as never, 'all')) as unknown as {
      rows: Array<{
        user_id: number;
        total_work_days: number;
        total_work_days_after_approval: number;
        early_leave_count: number;
        early_leave_approved: number;
        early_leave_minutes: number;
        compensated_days: number;
        cells: Record<number, { early_leave_compensated?: boolean }>;
      }>;
    };
    const a = res.rows.find((r) => r.user_id === 1)!;
    const b = res.rows.find((r) => r.user_id === 2)!;

    // user 1 (half_day + approved) → BÙ CÔNG
    expect(a.total_work_days).toBe(0.5);
    expect(a.total_work_days_after_approval).toBe(1);
    expect(a.compensated_days).toBe(1);
    expect(a.cells[18].early_leave_compensated).toBe(true);
    expect(a.early_leave_count).toBe(1);
    expect(a.early_leave_approved).toBe(1);
    expect(a.early_leave_minutes).toBe(240); // (8 − 4) × 60

    // user 2 (<4h + approved) → KHÔNG tự bù (chờ HR xử lý tay)
    expect(b.total_work_days).toBe(0);
    expect(b.total_work_days_after_approval).toBe(0);
    expect(b.compensated_days).toBe(0);
    expect(b.cells[18].early_leave_compensated).toBe(false);
    expect(b.early_leave_minutes).toBe(300); // (8 − 3) × 60
  });

  it('getWorkdaysMatrix: đơn về sớm bị từ chối → KHÔNG bù (after = thực tế)', async () => {
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      { id: 1, user_id: 1, work_date: WD, check_in_at: vn(WD, 8, 0), check_out_at: vn(WD, 12, 0), total_hours: 4, status: 'half_day', late_minutes: 0, user: rel('Bị Từ Chối') },
    ]);
    (prisma.attendanceRequest.findMany as jest.Mock).mockResolvedValue([
      { user_id: 1, work_date: WD, status: 'rejected' },
    ]);
    const res = (await service.getWorkdaysMatrix({
      date_from: '2026-06-18', date_to: '2026-06-18',
    } as never, 'all')) as unknown as {
      rows: Array<{ total_work_days: number; total_work_days_after_approval: number; early_leave_rejected: number; compensated_days: number }>;
    };
    expect(res.rows[0].total_work_days).toBe(0.5);
    expect(res.rows[0].total_work_days_after_approval).toBe(0.5);
    expect(res.rows[0].compensated_days).toBe(0);
    expect(res.rows[0].early_leave_rejected).toBe(1);
  });

  it('getEarlyLeaveStats: đếm approved/rejected/pending + tổng phút thiếu + top NV', async () => {
    (prisma.attendanceRequest.findMany as jest.Mock).mockResolvedValue([
      { user_id: 1, work_date: WD, status: 'approved' },
      { user_id: 1, work_date: WD2, status: 'rejected' },
      { user_id: 2, work_date: WD, status: 'pending' },
    ]);
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      { user_id: 1, work_date: WD, check_in_at: vn(WD, 8, 0), check_out_at: vn(WD, 12, 0), total_hours: 4, status: 'half_day' }, // deficit 240
      { user_id: 1, work_date: WD2, check_in_at: vn(WD2, 8, 0), check_out_at: vn(WD2, 11, 0), total_hours: 3, status: 'insufficient' }, // deficit 300
      { user_id: 2, work_date: WD, check_in_at: vn(WD, 8, 0), check_out_at: vn(WD, 11, 30), total_hours: 3.5, status: 'insufficient' }, // deficit 270
    ]);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 1, full_name: 'NV A', email: null },
      { id: 2, full_name: 'NV B', email: null },
    ]);

    const res = await service.getEarlyLeaveStats({ date_from: '2026-06-18', date_to: '2026-06-19' });

    expect(res.total).toBe(3);
    expect(res.approved).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.pending).toBe(1);
    expect(res.total_minutes).toBe(810); // 240 + 300 + 270
    expect(res.approval_rate).toBe(50); // 1 / (1 + 1)
    expect(res.top_leavers[0]).toMatchObject({ user_id: 1, count: 2, minutes: 540 });
    expect(res.top_leavers[1]).toMatchObject({ user_id: 2, count: 1, minutes: 270 });
  });

  it('getEarlyLeaveStats: không có đơn → rỗng', async () => {
    (prisma.attendanceRequest.findMany as jest.Mock).mockResolvedValue([]);
    const res = await service.getEarlyLeaveStats({ date_from: '2026-06-18', date_to: '2026-06-19' });
    expect(res).toEqual({
      total: 0, approved: 0, rejected: 0, pending: 0,
      total_minutes: 0, approval_rate: 0, top_leavers: [],
    });
  });
});

describe('AttendanceService — getRecordById văn phòng', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  it('trả check_in_office_name từ office_id đã lưu, fallback office gán cho check-out', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 5,
      user_id: 7,
      check_in_at: new Date('2026-06-19T01:00:00Z'),
      check_out_at: new Date('2026-06-19T10:00:00Z'),
      check_in_office_id: 1, // đã lưu lúc chấm vào
      check_out_office_id: null, // bản ghi cũ chưa lưu → fallback office gán
      check_in_lat: null,
      check_in_lng: null,
      status: 'present',
      total_hours: 8,
      user: { id: 7, full_name: 'NV A', email: 'a@x.vn', employee: { position: 'Sale', office_id: 2 } },
    });
    (prisma.attendanceOffice.findMany as jest.Mock).mockResolvedValue([
      { id: 1, name: 'Hà Nội' },
      { id: 2, name: 'Quận 1' },
    ]);

    const result = await service.getRecordById(5, 99, 'all');

    expect(result.check_in_office_name).toBe('Hà Nội');
    expect(result.check_out_office_name).toBe('Quận 1'); // fallback employee.office_id
  });

  it('không có office_id nào → office_name = null (KHÔNG ném lỗi)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 6,
      user_id: 7,
      check_in_at: new Date('2026-06-19T01:00:00Z'),
      check_out_at: null,
      check_in_office_id: null,
      check_out_office_id: null,
      check_in_lat: null,
      check_in_lng: null,
      status: 'incomplete',
      total_hours: null,
      user: { id: 7, full_name: 'NV B', email: 'b@x.vn', employee: { position: 'Sale', office_id: null } },
    });

    const result = await service.getRecordById(6, 7, [7]);

    expect(result.check_in_office_name).toBeNull();
    expect(result.check_out_office_name).toBeNull();
    expect(prisma.attendanceOffice.findMany).not.toHaveBeenCalled();
  });

  it('non-admin xem bản ghi của người khác → NotFoundException (404)', async () => {
    (prisma.attendanceRecord.findUnique as jest.Mock).mockResolvedValue({
      id: 8,
      user_id: 7,
      check_in_office_id: 1,
      check_out_office_id: 1,
      user: { id: 7, full_name: 'NV C', email: 'c@x.vn', employee: { position: 'Sale', office_id: 1 } },
    });

    await expect(service.getRecordById(8, 99, [99])).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('buildWorkdayList', () => {
  it('lấy T2–T6 trong khoảng, bỏ T7/CN khi không có working saturday', () => {
    // 2026-06-15 (T2) → 2026-06-21 (CN): workday = 15,16,17,18,19 (T2-T6)
    const days = buildWorkdayList('2026-06-15', '2026-06-21', new Set());
    expect(days).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
    ]);
  });

  it('thêm Thứ 7 nằm trong danh sách working saturdays', () => {
    // 2026-06-20 là Thứ 7
    const days = buildWorkdayList(
      '2026-06-19',
      '2026-06-21',
      new Set(['2026-06-20']),
    );
    expect(days).toEqual(['2026-06-19', '2026-06-20']); // T6 + T7-working, CN loại
  });

  it('khoảng 1 ngày CN → rỗng', () => {
    expect(buildWorkdayList('2026-06-21', '2026-06-21', new Set())).toEqual([]);
  });
});

describe('AttendanceService — getDisciplineStats', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  // Khoảng 2026-06-15 (T2) → 2026-06-17 (T4) = 3 ngày làm việc.
  const DTO = { date_from: '2026-06-15', date_to: '2026-06-17' };

  beforeEach(async () => {
    prisma = makePrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = moduleRef.get(AttendanceService);

    // roster: 2 NV — Emp1 (Nam, id 10), Emp2 (Nữ, id 20). 1 lần $queryRaw duy nhất.
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { user_id: 10, full_name: 'Nguyễn Văn A', employee_code: 'NV0010', position: 'Sale', gender: 'M', team_name: 'Team Alpha' },
      { user_id: 20, full_name: 'Trần Thị B', employee_code: 'NV0020', position: 'Sale', gender: 'F', team_name: 'Team Alpha' },
    ]);
    // records: Emp1 muộn+về sớm ngày 15, vắng ngày 16, đủ công ngày 17; Emp2 đủ công cả 3 ngày.
    (prisma.attendanceRecord.findMany as jest.Mock).mockResolvedValue([
      // Emp1 15/06: vào 08:30 VN (01:30Z) muộn 20', ra 16:30 VN (09:30Z) về sớm 30'
      { user_id: 10, work_date: new Date('2026-06-15T00:00:00.000Z'), check_in_at: new Date('2026-06-15T01:30:00.000Z'), check_out_at: new Date('2026-06-15T09:30:00.000Z'), total_hours: null, status: 'half_day' },
      // Emp1 17/06: vào 08:00 VN (01:00Z) đúng giờ, ra 17:30 VN (10:30Z) đủ công
      { user_id: 10, work_date: new Date('2026-06-17T00:00:00.000Z'), check_in_at: new Date('2026-06-17T01:00:00.000Z'), check_out_at: new Date('2026-06-17T10:30:00.000Z'), total_hours: null, status: 'present' },
      // Emp2: cả 3 ngày vào 08:00 ra 17:30
      { user_id: 20, work_date: new Date('2026-06-15T00:00:00.000Z'), check_in_at: new Date('2026-06-15T01:00:00.000Z'), check_out_at: new Date('2026-06-15T10:30:00.000Z'), total_hours: null, status: 'present' },
      { user_id: 20, work_date: new Date('2026-06-16T00:00:00.000Z'), check_in_at: new Date('2026-06-16T01:00:00.000Z'), check_out_at: new Date('2026-06-16T10:30:00.000Z'), total_hours: null, status: 'present' },
      { user_id: 20, work_date: new Date('2026-06-17T00:00:00.000Z'), check_in_at: new Date('2026-06-17T01:00:00.000Z'), check_out_at: new Date('2026-06-17T10:30:00.000Z'), total_hours: null, status: 'present' },
    ]);
    // attendanceRequest.findMany default [] (không có đơn early_leave duyệt) — từ makePrisma.
    // setting.findUnique default null → getShiftConfig=DEFAULT (work_end 17:00, late_after 08:10,
    //   full_day_min 8, lunch 12:00-13:30) + getWorkingSaturdays=[].
  });

  it('Top 10 nghỉ — chỉ NV có ngày vắng, kèm đợt + tỷ lệ', async () => {
    const res = await service.getDisciplineStats(DTO);
    expect(res.total_workdays).toBe(3);
    expect(res.top_absent).toHaveLength(1); // chỉ Emp1 vắng (Emp2 0 ngày)
    expect(res.top_absent[0]).toMatchObject({
      user_id: 10,
      absent_days: 1,
      absent_occurrences: 1,
      absent_rate: 33.3,
    });
  });

  it('Top 10 đi muộn/về sớm — phút muộn + phút về sớm + vi phạm', async () => {
    const res = await service.getDisciplineStats(DTO);
    expect(res.top_violation).toHaveLength(1); // chỉ Emp1 vi phạm
    expect(res.top_violation[0]).toMatchObject({
      user_id: 10,
      late_minutes: 20,
      early_minutes: 30,
      violation_minutes: 50,
      late_count: 1,
      early_count: 1,
    });
  });

  it('So sánh giới tính — Nam vs Nữ, mẫu số = headcount × total_workdays', async () => {
    const res = await service.getDisciplineStats(DTO);
    const male = res.by_gender.find((g) => g.gender === 'M');
    const female = res.by_gender.find((g) => g.gender === 'F');
    expect(male).toMatchObject({
      headcount: 1,
      total_absent_days: 1,
      total_late_count: 1,
      total_early_count: 1,
      full_attendance_rate: 33.3, // 1 ngày đủ công (17) / (1 NV × 3 ngày)
    });
    expect(female).toMatchObject({
      headcount: 1,
      total_absent_days: 0,
      full_attendance_rate: 100, // 3/3
    });
    expect(res.by_gender.find((g) => g.gender === 'unknown')).toBeUndefined();
  });

  it('Đơn early_leave đã duyệt → ngày đó KHÔNG tính về sớm', async () => {
    (prisma.attendanceRequest.findMany as jest.Mock).mockResolvedValueOnce([
      { user_id: 10, work_date: new Date('2026-06-15T00:00:00.000Z'), status: 'approved' },
    ]);
    const res = await service.getDisciplineStats(DTO);
    // Emp1 ngày 15 có đơn duyệt → early_minutes=0; vẫn còn muộn 20' từ ngày 15.
    const emp1 = res.top_violation.find((r) => r.user_id === 10);
    expect(emp1?.early_minutes).toBe(0);
    expect(emp1?.late_minutes).toBe(20);
  });

  it('roster rỗng → các mảng rỗng', async () => {
    (prisma.$queryRaw as jest.Mock).mockReset();
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    const res = await service.getDisciplineStats(DTO);
    expect(res.top_absent).toEqual([]);
    expect(res.top_violation).toEqual([]);
    expect(res.by_gender).toEqual([]);
  });
});

// ============================================================
// Phân tích nghỉ phép (4 biểu đồ) — getLeaveAnalytics + buildLeaveWeekBuckets
// ============================================================
describe('buildLeaveWeekBuckets', () => {
  it('1 tháng đủ → 5 tuần (W1–W5), nhãn + biên đúng', () => {
    const w = buildLeaveWeekBuckets('2026-06-01', '2026-06-30');
    expect(w).toHaveLength(5);
    expect(w[0]).toEqual({ label: 'Tuần 1', from: '2026-06-01', to: '2026-06-07' });
    expect(w[1]).toEqual({ label: 'Tuần 2', from: '2026-06-08', to: '2026-06-14' });
    expect(w[4]).toEqual({ label: 'Tuần 5', from: '2026-06-29', to: '2026-06-30' });
  });

  it('khoảng 1 ngày → 1 tuần; toStr < fromStr → rỗng', () => {
    expect(buildLeaveWeekBuckets('2026-06-10', '2026-06-10')).toEqual([
      { label: 'Tuần 1', from: '2026-06-10', to: '2026-06-10' },
    ]);
    expect(buildLeaveWeekBuckets('2026-06-10', '2026-06-09')).toEqual([]);
  });
});

describe('AttendanceService — getLeaveAnalytics', () => {
  let service: AttendanceService;
  let prisma: ReturnType<typeof makePrisma>;

  // work_date lưu UTC-midnight của ngày VN.
  const wd = (day: number) => new Date(Date.UTC(2026, 5, day));

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    service = module.get(AttendanceService);
  });

  const slice = (arr: Array<{ type?: string; gender?: string; value: number }>, key: string) =>
    arr.find((s) => s.type === key || s.gender === key)?.value;

  it('phân biệt approved (ngày) vs tất cả đơn (số đơn) + giới tính + tuần × phòng ban', async () => {
    // Roster đã scope: user_id → gender + department (đã COALESCE).
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
      { user_id: 1, gender: 'M', department: 'KD' },
      { user_id: 2, gender: 'F', department: 'MKT' },
      { user_id: 3, gender: null, department: 'Chưa phân phòng' },
    ]);
    (prisma.attendanceRequest.findMany as jest.Mock).mockResolvedValue([
      { user_id: 1, work_date: wd(3), type: 'leave', status: 'approved' }, // KD, Tuần 1, M
      { user_id: 1, work_date: wd(10), type: 'leave', status: 'approved' }, // KD, Tuần 2, M
      { user_id: 1, work_date: wd(16), type: 'forgot_check_in', status: 'approved' }, // KD, Tuần 3, M
      { user_id: 2, work_date: wd(3), type: 'maternity', status: 'approved' }, // MKT, Tuần 1, F
      { user_id: 2, work_date: wd(5), type: 'early_leave', status: 'pending' }, // KHÔNG vào approved
      { user_id: 3, work_date: wd(16), type: 'late_arrival', status: 'rejected' }, // KHÔNG vào approved
    ]);

    const res = await service.getLeaveAnalytics({
      date_from: '2026-06-01',
      date_to: '2026-06-30',
    });

    // Chart 2 — TẤT CẢ đơn theo loại
    expect(slice(res.by_type_requests, 'leave')).toBe(2);
    expect(slice(res.by_type_requests, 'maternity')).toBe(1);
    expect(slice(res.by_type_requests, 'early_leave')).toBe(1);
    expect(slice(res.by_type_requests, 'late_arrival')).toBe(1);
    expect(slice(res.by_type_requests, 'forgot_check_in')).toBe(1);
    expect(slice(res.by_type_requests, 'forgot_check_out')).toBe(0);
    expect(res.by_type_requests).toHaveLength(6); // luôn đủ 6 loại

    // Chart 1 — chỉ đơn ĐÃ DUYỆT
    expect(slice(res.by_type_days, 'leave')).toBe(2);
    expect(slice(res.by_type_days, 'maternity')).toBe(1);
    expect(slice(res.by_type_days, 'forgot_check_in')).toBe(1);
    expect(slice(res.by_type_days, 'early_leave')).toBe(0); // pending
    expect(slice(res.by_type_days, 'late_arrival')).toBe(0); // rejected

    // Chart 4 — ngày nghỉ (approved) theo giới tính
    expect(slice(res.by_gender, 'M')).toBe(3); // user1: leave×2 + forgot_check_in
    expect(slice(res.by_gender, 'F')).toBe(1); // user2: maternity
    expect(slice(res.by_gender, 'unknown')).toBe(0); // user3: chỉ rejected

    // Bất biến: Σ by_type_days === Σ by_gender
    const sumDays = res.by_type_days.reduce((s, x) => s + x.value, 0);
    const sumGender = res.by_gender.reduce((s, x) => s + x.value, 0);
    expect(sumDays).toBe(4);
    expect(sumGender).toBe(4);

    // Chart 3 — tuần × phòng ban (approved). 5 tuần, KD đứng trước MKT (tổng lớn hơn).
    expect(res.by_week.weeks).toHaveLength(5);
    expect(res.by_week.departments[0]).toEqual({ department: 'KD', values: [1, 1, 1, 0, 0] });
    expect(res.by_week.departments[1]).toEqual({ department: 'MKT', values: [1, 0, 0, 0, 0] });
    // Σ mọi by_week values === Σ by_type_days
    const sumWeek = res.by_week.departments
      .flatMap((d) => d.values)
      .reduce((s, v) => s + v, 0);
    expect(sumWeek).toBe(4);
  });

  it('roster rỗng → 6 loại = 0, departments rỗng, weeks vẫn dựng theo khoảng', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
    const res = await service.getLeaveAnalytics({
      date_from: '2026-06-01',
      date_to: '2026-06-07',
    });
    expect(res.by_type_days).toHaveLength(6);
    expect(res.by_type_days.every((s) => s.value === 0)).toBe(true);
    expect(res.by_type_requests.every((s) => s.value === 0)).toBe(true);
    expect(res.by_gender.map((g) => g.value)).toEqual([0, 0, 0]);
    expect(res.by_week.departments).toEqual([]);
    expect(res.by_week.weeks).toHaveLength(1);
    // KHÔNG query đơn khi roster rỗng
    expect(prisma.attendanceRequest.findMany as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('AttendanceService — giới hạn đơn theo tháng (monthly_forgot_limit / monthly_late_early_limit)', () => {
  const CFG = (forgot: number, lateEarly: number) =>
    JSON.stringify({ default_check_in: '08:00', default_check_out: '17:30', monthly_forgot_limit: forgot, monthly_late_early_limit: lateEarly });

  const buildService = async (prisma: PrismaService): Promise<AttendanceService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: makeStorage() },
        { provide: NotificationsService, useValue: makeNotifications() },
        { provide: ScopeService, useValue: makeScope() },
      ],
    }).compile();
    return module.get(AttendanceService);
  };

  const setup = async (cfg: string | null, used: number) => {
    const prisma = makePrisma({
      setting: { findUnique: jest.fn().mockResolvedValue(cfg ? { value: cfg } : null), upsert: jest.fn() },
      attendanceRequest: {
        count: jest.fn().mockResolvedValue(used),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 1, ...data, created_at: new Date(), updated_at: new Date(), reviewed_by: null, reviewed_at: null, review_note: null })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: { count: jest.fn(), findUnique: jest.fn().mockResolvedValue({ full_name: 'X', email: null }) },
    });
    const service = await buildService(prisma);
    return { prisma, service };
  };
  const dto = (type: string) =>
    ({ type, work_date: '2026-06-15', reason: 'lý do', requested_check_in: '08:00', requested_check_out: '17:30' }) as never;

  it('đủ hạn mức quên chấm công (2/2) → 400 tiếng Việt, KHÔNG tạo đơn', async () => {
    const { prisma, service } = await setup(CFG(2, 3), 2);
    await expect(service.createRequest(5, dto('forgot_check_in'))).rejects.toThrow(/hết 2 lần quên chấm công của tháng 06\/2026/);
    expect(prisma.attendanceRequest.create).not.toHaveBeenCalled();
  });

  it('đếm cả check-in lẫn check-out, đúng người, đúng tháng của ngày công, bỏ đơn bị từ chối', async () => {
    const { prisma, service } = await setup(CFG(2, 3), 1);
    await service.createRequest(5, dto('forgot_check_out'));
    expect(prisma.attendanceRequest.count).toHaveBeenCalledWith({
      where: {
        user_id: 5,
        type: { in: ['forgot_check_in', 'forgot_check_out'] },
        status: { in: ['pending', 'approved'] },
        work_date: { gte: new Date(Date.UTC(2026, 5, 1)), lt: new Date(Date.UTC(2026, 6, 1)) },
      },
    });
    expect(prisma.attendanceRequest.create).toHaveBeenCalled();
  });

  it('đủ hạn mức đi trễ/về sớm (3/3) → 400; đi trễ và về sớm dùng chung một hạn mức', async () => {
    for (const type of ['late_arrival', 'early_leave']) {
      const { prisma, service } = await setup(CFG(2, 3), 3);
      await expect(service.createRequest(5, dto(type))).rejects.toThrow(/hết 3 lần đi trễ\/về sớm của tháng 06\/2026/);
      expect(prisma.attendanceRequest.create).not.toHaveBeenCalled();
    }
  });

  it('dùng cấu hình mặc định (2 / 3) khi chưa cấu hình', async () => {
    const { service } = await setup(null, 2);
    await expect(service.createRequest(5, dto('forgot_check_in'))).rejects.toThrow(BadRequestException);
  });

  it('giới hạn 0 = không giới hạn; đơn nghỉ phép không bị giới hạn', async () => {
    const a = await setup(CFG(0, 0), 999);
    await expect(a.service.createRequest(5, dto('forgot_check_in'))).resolves.toBeDefined();
    await expect(a.service.createRequest(5, dto('late_arrival'))).resolves.toBeDefined();
    expect(a.prisma.attendanceRequest.count).not.toHaveBeenCalled();

    const b = await setup(CFG(1, 1), 999);
    await expect(b.service.createRequest(5, dto('leave'))).resolves.toBeDefined();
    expect(b.prisma.attendanceRequest.count).not.toHaveBeenCalled();
  });

  it('còn hạn mức (1/2 quên) → tạo được đơn', async () => {
    const { prisma, service } = await setup(CFG(2, 3), 1);
    await service.createRequest(5, dto('forgot_check_in'));
    expect(prisma.attendanceRequest.create).toHaveBeenCalledTimes(1);
  });
});
