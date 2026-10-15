import type { AuthUser } from '@trinity/rbac-nest';
import { RecordLinksService, coreFieldLabel } from '../refs/record-links.service';
import type { RefView } from '../refs/ref-types';

const view = (type: RefView['type'], id: number, code: string): RefView => ({ type, id, ref: `${type}:${id}`, code, title: code, table: 'T', href: null });
const user = { userId: 7 } as unknown as AuthUser;

function build(resolved: RefView[] | Error) {
  const created: { source_type: string; source_id: number; source_field: string; target_type: string; target_id: number }[] = [];
  const deleted: object[] = [];
  const prisma = {
    recordLink: {
      deleteMany: async (a: object) => { deleted.push(a); },
      createMany: async (a: { data: typeof created }) => { created.push(...a.data); },
    },
  };
  const refs = {
    resolveCodes: async () => {
      if (resolved instanceof Error) throw resolved;
      return new Map(resolved.map((v) => [v.code as string, v]));
    },
  };
  return { svc: new RecordLinksService(prisma as never, refs as never), created, deleted };
}

describe('thẻ @ ở màn lõi (mô tả công việc, ghi chú khách)', () => {
  it('nhãn trường lõi hiển thị tiếng Việt', () => {
    expect(coreFieldLabel('description')).toBe('Mô tả');
    expect(coreFieldLabel('reminder_notes')).toBe('Ghi chú nhắc');
    expect(coreFieldLabel('note:12')).toBe('Ghi chú');
    expect(coreFieldLabel('comment:3')).toBe('Bình luận');
  });

  it('ghi cạnh từ nguồn lõi tới đích người ghi thấy được; mã không thấy bị bỏ', async () => {
    const { svc, created, deleted } = build([view('record', 3, 'BN001'), view('contact', 9, 'KH009')]);
    await svc.syncMentions({ type: 'task', id: 5 }, 'description', 'Gọi @BN001, @KH009 và @XX999', user);
    expect(deleted).toHaveLength(1);
    expect(created.map((c) => `${c.source_type}:${c.source_id}/${c.source_field}->${c.target_type}:${c.target_id}`).sort())
      .toEqual(['task:5/description->contact:9', 'task:5/description->record:3']);
  });

  it('text rỗng/null chỉ xoá cạnh cũ', async () => {
    const { svc, created, deleted } = build([]);
    await svc.syncMentions({ type: 'contact', id: 2 }, 'reminder_notes', null, user);
    expect(deleted).toHaveLength(1);
    expect(created).toHaveLength(0);
  });

  it('nhắc chính mình không tạo cạnh; lỗi tra cứu không làm hỏng thao tác lưu', async () => {
    const self = build([view('task', 5, 'CV005')]);
    await self.svc.syncMentions({ type: 'task', id: 5 }, 'description', '@CV005', user);
    expect(self.created).toHaveLength(0);
    const broken = build(new Error('db sập'));
    await expect(broken.svc.syncMentions({ type: 'task', id: 5 }, 'description', '@BN001', user)).resolves.toBeUndefined();
  });
});

describe('thẻ @ trong bình luận công việc', () => {
  it('bình luận: cạnh gắn vào task, trường comment:<id>; xoá @ thì cạnh cũ bị xoá', async () => {
    const { svc, created, deleted } = build([view('contact', 9, 'KH009')]);
    await svc.syncMentions({ type: 'task', id: 5 }, 'comment:77', 'Xem @KH009', user);
    expect(created.map((c) => `${c.source_type}:${c.source_id}/${c.source_field}->${c.target_type}:${c.target_id}`)).toEqual(['task:5/comment:77->contact:9']);
    await svc.syncMentions({ type: 'task', id: 5 }, 'comment:77', 'không còn thẻ', user);
    expect(deleted).toHaveLength(2);
    expect(created).toHaveLength(1);
  });

});
