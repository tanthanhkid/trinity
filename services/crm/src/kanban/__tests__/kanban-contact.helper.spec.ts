import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import {
  assertContactFieldMutable,
  assertContactLinkable,
  resolveKanbanCardContactDisplays,
} from '../common/kanban-contact.helper';

function mkUser(grants: Grants, userId = 1): AuthUser {
  return { userId, email: 'x@test.com', isAdmin: false, grants };
}

function mkScope(ownerByPerm: Record<string, number[] | 'all' | null>): ScopeService {
  return {
    ownerIds: jest.fn(async (_user: AuthUser, perm: string) => ownerByPerm[perm] ?? null),
  } as unknown as ScopeService;
}

describe('kanban-contact.helper — quyền contacts.* độc lập với cụm Danh bạ', () => {
  describe('assertContactFieldMutable', () => {
    it('không có contacts.view => 403', () => {
      expect(() => assertContactFieldMutable(mkUser({}))).toThrow(ForbiddenException);
    });
    it('có contacts.view (kể cả scope own) => qua', () => {
      expect(() => assertContactFieldMutable(mkUser({ 'contacts.view': 'own' }))).not.toThrow();
    });
  });

  describe('assertContactLinkable', () => {
    it('contact không tồn tại => 404', async () => {
      const prisma = { contact: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
      const scope = mkScope({});
      await expect(
        assertContactLinkable(prisma, scope, mkUser({ 'contacts.view': 'all' }), 1),
      ).rejects.toThrow(NotFoundException);
    });

    it('contact ngoài phạm vi contacts.view => 404 (KHÔNG 403)', async () => {
      const prisma = {
        contact: {
          findUnique: jest.fn().mockResolvedValue({ id: 1, assigned_to: 999, created_by_id: 998 }),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': [1, 2] });
      await expect(
        assertContactLinkable(prisma, scope, mkUser({ 'contacts.view': 'own' }), 1),
      ).rejects.toThrow(NotFoundException);
    });

    it('contact trong phạm vi (assigned_to khớp) => qua', async () => {
      const prisma = {
        contact: {
          findUnique: jest.fn().mockResolvedValue({ id: 1, assigned_to: 2, created_by_id: 998 }),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': [1, 2] });
      await expect(
        assertContactLinkable(prisma, scope, mkUser({ 'contacts.view': 'team' }), 1),
      ).resolves.toBeUndefined();
    });

    it('scope all => luôn qua', async () => {
      const prisma = {
        contact: {
          findUnique: jest.fn().mockResolvedValue({ id: 1, assigned_to: 999, created_by_id: 998 }),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': 'all' });
      await expect(
        assertContactLinkable(prisma, scope, mkUser({ 'contacts.view': 'all' }), 1),
      ).resolves.toBeUndefined();
    });
  });

  describe('resolveKanbanCardContactDisplays', () => {
    it('không có contacts.view => null cho MỌI contact', async () => {
      const prisma = { contact: { findMany: jest.fn() } } as unknown as PrismaService;
      const scope = mkScope({});
      const result = await resolveKanbanCardContactDisplays(prisma, scope, mkUser({}), [1, 2]);
      expect(result.get(1)).toBeNull();
      expect(result.get(2)).toBeNull();
      expect(prisma.contact.findMany).not.toHaveBeenCalled();
    });

    it('contact ngoài phạm vi contacts.view => null, KHÔNG throw', async () => {
      const prisma = {
        contact: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 1, full_name: 'A', phone: '0912345678', assigned_to: 999, created_by_id: 998 },
            ]),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': [1], 'contacts.phone_full': [1] });
      const result = await resolveKanbanCardContactDisplays(
        prisma,
        scope,
        mkUser({ 'contacts.view': 'own' }),
        [1],
      );
      expect(result.get(1)).toBeNull();
    });

    it('trong phạm vi + KHÔNG có contacts.phone_full => SĐT bị che (***xxx)', async () => {
      const prisma = {
        contact: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 1, full_name: 'A', phone: '0912345678', assigned_to: 1, created_by_id: 998 },
            ]),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': [1], 'contacts.phone_full': [] });
      const result = await resolveKanbanCardContactDisplays(
        prisma,
        scope,
        mkUser({ 'contacts.view': 'own' }),
        [1],
      );
      expect(result.get(1)).toEqual({ id: 1, full_name: 'A', phone: '***678', masked: true });
    });

    it('trong phạm vi + CÓ contacts.phone_full (scope phủ owner) => SĐT đầy đủ', async () => {
      const prisma = {
        contact: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 1, full_name: 'A', phone: '0912345678', assigned_to: 1, created_by_id: 998 },
            ]),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': 'all', 'contacts.phone_full': [1] });
      const result = await resolveKanbanCardContactDisplays(
        prisma,
        scope,
        mkUser({ 'contacts.view': 'all' }),
        [1],
      );
      expect(result.get(1)).toEqual({ id: 1, full_name: 'A', phone: '0912345678', masked: false });
    });

    it('trùng id trong input => chỉ query 1 lần cho id duy nhất', async () => {
      const prisma = {
        contact: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as unknown as PrismaService;
      const scope = mkScope({ 'contacts.view': 'all' });
      await resolveKanbanCardContactDisplays(prisma, scope, mkUser({ 'contacts.view': 'all' }), [1, 1, 2]);
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [1, 2] }, deleted_at: null } }),
      );
    });
  });
});
