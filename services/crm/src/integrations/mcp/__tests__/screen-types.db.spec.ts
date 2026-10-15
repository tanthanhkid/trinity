/**
 * Loại màn qua MCP — DB THẬT: loại lạ bị từ chối và KHÔNG ghi gì (create_view, update_view, propose_workspace); loại hợp lệ
 * ghi đúng cấu hình; list_screen_types đọc trường thật của bảng. Chỉ chạy khi có TEST_DATABASE_URL (DB đã migrate), vd:
 *   TEST_DATABASE_URL=postgresql://localhost:5432/trinity_test pnpm --filter @trinity/crm test screen-types.db
 */
import { PrismaClient } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { CustomViewsService } from '../../../custom-objects/custom-views.service';
import { VIEW_TYPES } from '../../../custom-objects/view-config';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionDeps } from '../actions/action-types';
import type { McpPrincipal } from '../mcp-auth.service';
import { listScreenTypesTool } from '../tools/screen-types-tool';
import type { McpDeps } from '../tools/tool-types';
import { useDbSpecLock } from '../../../test-utils/db-spec-lock';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const GRANTS = { 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_objects.manage': true } as unknown as Grants;

d('Loại màn qua MCP — DB thật', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let deps: ActionDeps & McpDeps;
  let user: AuthUser;
  const act = (n: string) => actionToolByName(n)!;
  const listed = (msg: string) => VIEW_TYPES.every((t) => msg.includes(t)) && msg.includes('group_by') && msg.includes('date_field');

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    deps = { prisma, views: new CustomViewsService(prisma as never) } as unknown as ActionDeps & McpDeps;
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE custom_records, custom_fields, custom_views, custom_objects, users RESTART IDENTITY CASCADE');
    const u = await prisma.user.create({ data: { email: 'admin@t.vn', password_hash: 'x', full_name: 'Admin' } });
    user = { userId: u.id, email: u.email, isAdmin: true, grants: GRANTS };
    const o = await prisma.customObject.create({ data: { key: 'don_hang', label: 'Đơn hàng', label_plural: 'Đơn hàng' } });
    await prisma.customField.createMany({ data: [
      { object_id: o.id, key: 'ten_don', label: 'Tên đơn', type: 'text', is_title: true, required: true },
      { object_id: o.id, key: 'trang_thai', label: 'Trạng thái', type: 'select', options: { choices: [{ value: 'moi', label: 'Mới' }, { value: 'xong', label: 'Xong' }] } },
      { object_id: o.id, key: 'ngay_giao', label: 'Ngày giao', type: 'date' },
    ] });
  });

  it('create_view loại lạ ⇒ lỗi có danh sách loại, không ghi view nào', async () => {
    for (const type of ['gantt', 'bieu_do_3d', 'dashboard']) {
      const err = await act('create_view').prepare({ object: 'don_hang', label: 'X', type }, { deps, user }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ActionUserError);
      expect(listed((err as Error).message)).toBe(true);
    }
    expect(await prisma.customView.count()).toBe(0);
  });

  it('create_view hợp lệ ghi đúng loại + cấu hình; update_view sang loại lạ bị từ chối, view giữ nguyên', async () => {
    const k = await act('create_view').prepare({ object: 'don_hang', label: 'Pipeline đơn', type: 'kanban', group_by: 'trang_thai' }, { deps, user });
    await act('create_view').execute(k.params, { deps, user }, 1);
    const c = await act('create_view').prepare({ object: 'don_hang', label: 'Lịch giao', type: 'calendar', date_field: 'ngay_giao', mode: 'week' }, { deps, user });
    await act('create_view').execute(c.params, { deps, user }, 2);
    const rows = await prisma.customView.findMany({ orderBy: { id: 'asc' }, select: { key: true, type: true, config: true } });
    expect(rows).toMatchObject([{ type: 'kanban', config: { group_by: 'trang_thai' } }, { type: 'calendar', config: { date_field: 'ngay_giao', mode: 'week' } }]);
    await expect(act('update_view').prepare({ object: 'don_hang', view: rows[0].key, type: 'map' }, { deps, user })).rejects.toThrow(/chưa được Trinity hỗ trợ/);
    expect((await prisma.customView.findFirstOrThrow({ where: { key: rows[0].key } })).type).toBe('kanban');
  });

  it('propose_workspace có view loại lạ ⇒ từ chối lúc kiểm, không tạo bảng nào', async () => {
    const before = await prisma.customObject.count();
    const err = await act('propose_workspace').prepare({
      title: 'Gói thử', objects: [{ key: 'lich_hen', label: 'Lịch hẹn', fields: [{ label: 'Khách', type: 'text' }, { label: 'Giờ hẹn', type: 'datetime' }] }],
      views: [{ object: 'lich_hen', label: 'Biểu đồ', type: 'chart' }],
    }, { deps, user }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expect(listed((err as Error).message)).toBe(true);
    expect(await prisma.customObject.count()).toBe(before);
  });

  it('list_screen_types đọc trường THẬT của bảng: select cho kanban, date cho calendar', async () => {
    const principal = { userId: user.userId, email: user.email, clientId: 'c', scopes: ['crm.read'], tokenId: BigInt(1), user } as McpPrincipal;
    const out = await listScreenTypesTool.run({ object: 'don_hang' }, { principal, deps, baseUrl: 'https://x' });
    const data = out.structured.data as { screen_types: { type: string }[]; object: { kanban_group_by_fields: { key: string }[]; calendar_date_fields: { key: string }[] } };
    expect(data.screen_types.map((t) => t.type)).toEqual([...VIEW_TYPES]);
    expect(data.object.kanban_group_by_fields.map((f) => f.key)).toEqual(['trang_thai']);
    expect(data.object.calendar_date_fields.map((f) => f.key)).toEqual(['ngay_giao']);
  });
});
