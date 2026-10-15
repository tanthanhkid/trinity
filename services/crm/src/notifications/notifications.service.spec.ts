import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { NotificationsService } from './notifications.service';
import { CRM_WS_EMIT_PORT } from './ws-emit.port';

/**
 * Test `createPendingLogs` (hạ tầng dùng chung) và `notifyDealAssigned`.
 */

// Port phát WS in-process.
const mockWsEmit = jest.fn().mockResolvedValue({ emitted: 1 });

function createMockPrisma() {
  return {
    userRole: {
      findMany: jest.fn(),
    },
    notificationLog: {
      createMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CRM_WS_EMIT_PORT, useValue: { emit: mockWsEmit } },
      ],
    }).compile();
    service = module.get<NotificationsService>(NotificationsService);
    // Fake timer de test retry backoff khong doi that 500/1500/4500ms.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockWsEmit.mockReset();
    mockWsEmit.mockResolvedValue({ emitted: 1 });
  });

  describe('createPendingLogs (Layer 1 persistence + retry)', () => {
    const content = { title: 'T', body: 'B', action_url: '/contacts/1' };

    it('return created:0 khi userIds rong', async () => {
      const result = await service.createPendingLogs([], 'test.event', content);
      expect(result.created).toBe(0);
      expect(prisma.notificationLog.createMany).not.toHaveBeenCalled();
    });

    it('insert thanh cong lan dau, khong retry', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 2 });
      const result = await service.createPendingLogs(
        [1, 2],
        'test.event',
        content,
      );
      expect(result.created).toBe(2);
      expect(prisma.notificationLog.createMany).toHaveBeenCalledTimes(1);
    });

    it('retry 1 lan khi DB fail, thanh cong lan 2', async () => {
      prisma.notificationLog.createMany
        .mockRejectedValueOnce(new Error('pool timeout'))
        .mockResolvedValueOnce({ count: 1 });

      const promise = service.createPendingLogs(
        [99],
        'test.event',
        content,
      );
      await jest.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result.created).toBe(1);
      expect(prisma.notificationLog.createMany).toHaveBeenCalledTimes(2);
    });

    it('throw err khi ca 4 lan (1 + 3 retry) deu fail', async () => {
      const err = new Error('DB down');
      prisma.notificationLog.createMany.mockRejectedValue(err);

      const promise = service.createPendingLogs(
        [7],
        'test.event',
        content,
      );
      // Catch ngay lap tuc de tranh unhandled rejection khi advance timer.
      const caught = promise.catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(500);
      await jest.advanceTimersByTimeAsync(1500);
      await jest.advanceTimersByTimeAsync(4500);
      const result = await caught;

      expect(result).toBe(err);
      expect(prisma.notificationLog.createMany).toHaveBeenCalledTimes(4);
    });

    it('pass skipDuplicates=true de dedupe (recipient_id, event_type) khi retry', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 1 });
      await service.createPendingLogs([1], 'test.event', content);
      const call = prisma.notificationLog.createMany.mock.calls[0][0] as {
        skipDuplicates: boolean;
      };
      expect(call.skipDuplicates).toBe(true);
    });

    it('emitWsFireAndForget: gọi port in-process đúng items (không HTTP)', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 2 });
      await service.createPendingLogs([1, 2], 'test.event', content);
      expect(mockWsEmit).toHaveBeenCalledTimes(1);
      const items = mockWsEmit.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(items.map((i) => i.recipient_id)).toEqual([1, 2]);
      expect(items[0]).toMatchObject({
        event_type: 'test.event',
        title: content.title,
        body: content.body,
        action_url: content.action_url,
      });
    });

    it('emitWsFireAndForget: không phát khi không insert được dòng nào', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 0 });
      await service.createPendingLogs([1], 'test.event', content);
      expect(mockWsEmit).not.toHaveBeenCalled();
    });

    it('emitWsFireAndForget: không throw nhưng log ERROR (không nuốt âm thầm) khi port emit lỗi', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 1 });
      mockWsEmit.mockRejectedValueOnce(new Error('gateway down'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorSpy = jest.spyOn((service as any).logger, 'error');

      jest.useRealTimers();
      await expect(
        service.createPendingLogs([5], 'test.event', content),
      ).resolves.toEqual({ created: 1 });
      await new Promise((r) => setImmediate(r));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('gateway down'),
      );
      errorSpy.mockRestore();
    });

    it('emitWsFireAndForget: log ERROR khi port chưa được nối (chạy ngoài monolith)', async () => {
      const bare = await Test.createTestingModule({
        providers: [
          NotificationsService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();
      const svc = bare.get(NotificationsService);
      prisma.notificationLog.createMany.mockResolvedValue({ count: 1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorSpy = jest.spyOn((svc as any).logger, 'error');

      await expect(
        svc.createPendingLogs([1], 'test.event', content),
      ).resolves.toEqual({ created: 1 });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRM_WS_EMIT_PORT chưa được nối'),
      );
      errorSpy.mockRestore();
    });
  });

  describe('notifyDealAssigned', () => {
    it('tạo 1 notification cho sale được giao thương vụ, action_url = /contacts/:id khi có contactId', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 1 });
      const result = await service.notifyDealAssigned({
        dealId: 10,
        dealTitle: 'Thương vụ A',
        saleUserId: 5,
        creatorName: 'Admin X',
        contactId: 42,
      });
      expect(result.created).toBe(1);
      const call = prisma.notificationLog.createMany.mock.calls[0][0] as {
        data: Array<{ recipient_id: number; event_type: string; action_url: string | null }>;
      };
      expect(call.data).toEqual([
        expect.objectContaining({
          recipient_id: 5,
          event_type: 'deal.assigned',
          action_url: '/contacts/42',
        }),
      ]);
    });

    it('action_url = /contacts (list) khi deal không gắn contact', async () => {
      prisma.notificationLog.createMany.mockResolvedValue({ count: 1 });
      await service.notifyDealAssigned({
        dealId: 11,
        dealTitle: 'Thương vụ B',
        saleUserId: 6,
        creatorName: 'Admin Y',
        contactId: null,
      });
      const call = prisma.notificationLog.createMany.mock.calls[0][0] as {
        data: Array<{ action_url: string | null }>;
      };
      expect(call.data[0].action_url).toBe('/contacts');
    });
  });
});
