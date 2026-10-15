import { ContactsService } from '../contacts.service';

describe('ContactsService.update — ghi activity stage_change khi đổi giai đoạn', () => {
  const existing = { id: 1, assigned_to: 5, created_by_id: 5, team_id: null, full_name: 'A', source_id: 1, source_locked: false, phone: '0900000001', stage_id: 11 };
  const build = (newStageId: number | null) => {
    const row = { ...existing, stage_id: newStageId, phone_2: null, project_id: null, deleted_at: null, created_at: new Date(), updated_at: new Date() };
    const tx = {
      contact: { update: jest.fn().mockResolvedValue(row) },
      integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
      settingOption: { findMany: jest.fn().mockResolvedValue([{ id: 11, label: 'Mới' }, { id: 12, label: 'Đang tư vấn' }]) },
      activity: { create: jest.fn().mockResolvedValue({ id: 99 }) },
    };
    const prisma = {
      contact: { findFirst: jest.fn().mockResolvedValue(existing), count: jest.fn().mockResolvedValue(0) },
      settingOption: { findUnique: jest.fn().mockResolvedValue({ id: 12, group_key: 'contact_stage', is_active: true, value: 'follow_up_1' }) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
    const svc = new ContactsService(prisma as never, {} as never, {} as never, scope as never, {} as never, {} as never);
    return { svc, tx };
  };
  const admin = { userId: 5, isAdmin: true, grants: {} } as never;

  it('đổi giai đoạn ⇒ một activity "Mới → Đang tư vấn" trong cùng transaction', async () => {
    const { svc, tx } = build(12);
    await svc.update(1, { stage_id: 12 } as never, admin);
    expect(tx.activity.create).toHaveBeenCalledTimes(1);
    const data = tx.activity.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      contact_id: 1,
      action: 'stage_change',
      created_by: 5,
      details: { description: 'Đổi giai đoạn: Mới → Đang tư vấn', from_stage_id: 11, to_stage_id: 12, from_label: 'Mới', to_label: 'Đang tư vấn' },
    });
    // outbox vẫn bắn như cũ
    expect(tx.integrationEvent.create.mock.calls.map((c) => c[0].data.event_type)).toContain('contact.stage_changed');
  });

  it('giữ nguyên giai đoạn ⇒ không ghi activity', async () => {
    const { svc, tx } = build(11);
    await svc.update(1, { stage_id: 11 } as never, admin);
    expect(tx.activity.create).not.toHaveBeenCalled();
  });

  it('sửa trường khác (không gửi stage_id) ⇒ không ghi activity', async () => {
    const { svc, tx } = build(11);
    await svc.update(1, { job_title: 'Giám đốc' } as never, admin);
    expect(tx.activity.create).not.toHaveBeenCalled();
  });
});
