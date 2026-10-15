import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { type AuthUser, type ScopeService } from '@trinity/rbac-nest';
import { ActivitiesController } from '../../../activities/activities.controller';
import { ActivitiesService } from '../../../activities/activities.service';

/**
 * Khoá bất biến "controller CÓ gọi gate" cho `GET /contacts/:id/activities`: xoá dòng gate khỏi
 * controller (tức là xoá chính bản sửa) mà test chỉ kiểm hàm gate thì vẫn xanh — nên spec này
 * dựng controller thật.
 *
 * Gate INLINE `assertInScope(scope, user, 'contacts.view', [assigned_to, created_by_id])`.
 * Mock `ScopeService.ownerIds` trả `[39]` khi gọi cho user id=39 (owner), `[]` cho user khác —
 * mô phỏng phạm vi `contacts.view = 'own'`.
 */

const OUT_OF_SCOPE_CONTACT = {
  assigned_to: 39,
  created_by_id: 39,
};

function makeUser(userId: number): AuthUser {
  return { userId, email: `u${userId}@trinity.local`, isAdmin: false, grants: {} };
}

const OUTSIDER = makeUser(155);
const OWNER = makeUser(39);

function buildPrisma() {
  return {
    contact: { findUnique: jest.fn(async () => OUT_OF_SCOPE_CONTACT) },
  } as unknown as PrismaService;
}

function buildScope(): ScopeService {
  return {
    ownerIds: jest.fn(async (user: AuthUser) => (user.userId === 39 ? [39] : [])),
  } as unknown as ScopeService;
}

describe('RBAC endpoint ĐỌC timeline Danh bạ', () => {
  describe('ActivitiesController', () => {
    const buildController = () => {
      const service = {
        findByContact: jest.fn(async () => ({ data: [], next_cursor: null })),
      } as unknown as ActivitiesService;
      return {
        service,
        controller: new ActivitiesController(service, buildPrisma(), buildScope()),
      };
    };

    it('GET /contacts/:id/activities — ngoài phạm vi: 404 + KHÔNG gọi service', async () => {
      const { controller, service } = buildController();
      await expect(
        controller.findByContact(1, OUTSIDER),
      ).rejects.toThrow(NotFoundException);
      expect(service.findByContact).not.toHaveBeenCalled();
    });

    it('GET /contacts/:id/activities — sale phụ trách: trả dữ liệu', async () => {
      const { controller, service } = buildController();
      await controller.findByContact(1, OWNER);
      expect(service.findByContact).toHaveBeenCalledWith(1, undefined, 20);
    });
  });
});
