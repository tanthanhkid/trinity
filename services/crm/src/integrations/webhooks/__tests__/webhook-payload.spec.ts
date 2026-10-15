import { evaluateEvent, scrubDigitRuns, type ActorScopes } from '../webhook-payload';

const contact = (over: Record<string, unknown> = {}) => ({
  contact: {
    id: 1, phone: '0912345678', phone_2: '0987654321', full_name: 'Nguyễn A', email: 'a@x.vn', zalo_account: '0912345678',
    assigned_to: 7, created_by_id: 8, ...over,
  },
});
const scopes = (o: Partial<ActorScopes> = {}): ActorScopes => ({ contactsView: 'all', dealsView: 'all', posSell: 'all', phoneFull: 'all',
  customView: 'all', customPhoneFull: 'all', roleIds: [], canManageCustomObjects: false, ...o });

describe('evaluateEvent — che SĐT theo quyền của chủ thể', () => {
  it('phone_full phủ owner → SĐT nguyên vẹn', () => {
    const r = evaluateEvent('contact.created', contact(), scopes());
    expect(r.deliver).toBe(true);
    expect((r.data.contact as Record<string, unknown>).phone).toBe('0912345678');
  });

  it('không có phone_full (null) → che phone, phone_2, zalo_account dạng số', () => {
    const r = evaluateEvent('contact.created', contact(), scopes({ phoneFull: null }));
    const c = r.data.contact as Record<string, unknown>;
    expect(c.phone).toBe('***678');
    expect(c.phone_2).toBe('***321');
    expect(c.zalo_account).toBe('***678');
    expect(c.email).toBe('a@x.vn'); // chỉ che SĐT
    expect(JSON.stringify(r.data)).not.toContain('0912345678');
  });

  it('phone_full scope own: rõ khi owner là chủ thể, che khi không', () => {
    expect((evaluateEvent('contact.updated', contact({ assigned_to: 7 }), scopes({ phoneFull: [7] })).data.contact as Record<string, unknown>).phone).toBe('0912345678');
    expect((evaluateEvent('contact.updated', contact({ assigned_to: 9, created_by_id: 9 }), scopes({ phoneFull: [7] })).data.contact as Record<string, unknown>).phone).toBe('***678');
  });

  it('idempotent: payload đã che rồi chạy lại không méo; null giữ null', () => {
    const once = evaluateEvent('contact.created', contact({ phone_2: null }), scopes({ phoneFull: null }));
    const twice = evaluateEvent('contact.created', once.data, scopes({ phoneFull: null }));
    expect(twice.data).toEqual(once.data);
    expect((twice.data.contact as Record<string, unknown>).phone_2).toBeNull();
  });

  it('không sửa đầu vào', () => {
    const input = contact();
    evaluateEvent('contact.created', input, scopes({ phoneFull: null }));
    expect(input.contact.phone).toBe('0912345678');
  });
});

describe('evaluateEvent — chủ thể chỉ nhận thứ nó xem được', () => {
  it('contact ngoài phạm vi contacts.view → không gửi; không quyền (null) → không gửi', () => {
    expect(evaluateEvent('contact.created', contact(), scopes({ contactsView: [1, 2] })).deliver).toBe(false);
    expect(evaluateEvent('contact.created', contact(), scopes({ contactsView: null })).deliver).toBe(false);
    expect(evaluateEvent('contact.created', contact(), scopes({ contactsView: [8] })).deliver).toBe(true); // người tạo
  });

  it('contact.assigned: thấy được nếu from/to user thuộc phạm vi', () => {
    const p = { ...contact({ assigned_to: 50, created_by_id: 51 }), from_user_id: 7, to_user_id: 50 };
    expect(evaluateEvent('contact.assigned', p, scopes({ contactsView: [7] })).deliver).toBe(true);
    expect(evaluateEvent('contact.assigned', p, scopes({ contactsView: [99] })).deliver).toBe(false);
  });

  it('deal theo deals.view; POS theo pos.sell; loại lạ không gửi', () => {
    const deal = { deal: { id: 1, title: 'Gọi 0912345678 chốt', description: null, note: 'sdt 0987654321', assigned_to: 3, created_by: 4 } };
    expect(evaluateEvent('deal.won', deal, scopes({ dealsView: [3] })).deliver).toBe(true);
    expect(evaluateEvent('deal.won', deal, scopes({ dealsView: [99] })).deliver).toBe(false);
    const order = { order: { id: 1, code: 'A1', note: 'khách 0912345678', created_by: 3, paid_by: 4, payments: [{ method: 'momo', amount: '1', reference: '0912345678' }] } };
    expect(evaluateEvent('pos.order.completed', order, scopes({ posSell: [4] })).deliver).toBe(true);
    expect(evaluateEvent('pos.order.completed', order, scopes({ posSell: null })).deliver).toBe(false);
    expect(evaluateEvent('nope' as never, {}, scopes()).deliver).toBe(false);
  });

  it('deal/POS: văn bản tự do bị che SĐT khi thiếu phone_full, giữ nguyên khi đủ quyền', () => {
    const deal = { deal: { id: 1, title: 'Gọi 0912345678 chốt', description: 'x', note: 'sdt +84 987 654 321', assigned_to: 3, created_by: 4 } };
    const masked = evaluateEvent('deal.created', deal, scopes({ phoneFull: null })).data.deal as Record<string, unknown>;
    expect(masked.title).toBe('Gọi ***678 chốt');
    expect(masked.note).toBe('sdt ***321');
    const clear = evaluateEvent('deal.created', deal, scopes()).data.deal as Record<string, unknown>;
    expect(clear.title).toBe('Gọi 0912345678 chốt');
    const order = { order: { id: 1, note: '0912345678', created_by: 3, paid_by: 4, payments: [{ reference: '0912345678' }] } };
    const o = evaluateEvent('pos.order.completed', order, scopes({ phoneFull: null })).data.order as { note: string; payments: Array<{ reference: string }> };
    expect(o.note).toBe('***678');
    expect(o.payments[0].reference).toBe('***678');
  });
});

describe('evaluateEvent — SĐT giấu trong văn bản tự do của khách', () => {
  it('tên/email/lý do chuyển: che khi thiếu phone_full, giữ nguyên khi đủ quyền', () => {
    const p = { ...contact({ full_name: 'Chị Lan 0912345678', email: '0912345678@gmail.com' }), from_user_id: 7, to_user_id: 9, reason: 'gọi (090) 123 4567 giúp' };
    const hidden = evaluateEvent('contact.assigned', p, scopes({ phoneFull: null }));
    const c = hidden.data.contact as Record<string, unknown>;
    expect(c.full_name).toBe('Chị Lan ***678');
    expect(c.email).toBe('***678@gmail.com');
    expect(hidden.data.reason).toBe('gọi ***567 giúp');
    expect(JSON.stringify(hidden.data)).not.toMatch(/0912345678|090\) 123/);
    const shown = evaluateEvent('contact.assigned', p, scopes());
    expect((shown.data.contact as Record<string, unknown>).full_name).toBe('Chị Lan 0912345678');
    expect(shown.data.reason).toBe('gọi (090) 123 4567 giúp');
  });
});

describe('scrubDigitRuns', () => {
  it('nhiều kiểu phân cách: ( ) / _', () => {
    expect(scrubDigitRuns('a (090) 123 4567 b')).toBe('a ***567 b');
    expect(scrubDigitRuns('0901/234/567')).toBe('***567');
    expect(scrubDigitRuns('0901_234_567')).toBe('***567');
    expect(scrubDigitRuns('(+84) 901 234 567')).toBe('(***567'); // không lộ số
    expect(scrubDigitRuns('mã 12345678, SL (8)')).toBe('mã 12345678, SL (8)'); // 8 số + dấu phẩy: không che
    expect(scrubDigitRuns('mã 12345678 (8 số)')).toBe('mã ***788 số)'); // dính liền ⇒ che thừa còn hơn lộ (có chủ ý, thiên về an toàn)
  });

  it('che dãy ≥ 9 chữ số, chừa số ngắn (mã đơn, năm, số lượng)', () => {
    expect(scrubDigitRuns('đơn 12345 năm 2026 sl 3')).toBe('đơn 12345 năm 2026 sl 3');
    expect(scrubDigitRuns('0912.345.678 và 0987-654-321')).toBe('***678 và ***321');
  });
});

describe('evaluateEvent — custom_record', () => {
  const ev = (over: Record<string, unknown> = {}, obj: Record<string, unknown> = {}) => ({
    object: { id: 1, key: 'phu_huynh', label: 'Phụ huynh', is_active: true, visible_role_ids: [], ...obj },
    record: {
      id: 5, title: 'Chị Lan', owner_id: 7, created_by: 8, phone_fields: ['sdt'],
      data: { sdt: '0912345678', ghi_chu: 'gọi 0987654321 nhé', ten: 'Lan' }, ...over,
    },
  });

  it('thiếu phạm vi xem → không gửi; đủ → gửi', () => {
    expect(evaluateEvent('custom_record.created', ev(), scopes({ customView: null })).deliver).toBe(false);
    expect(evaluateEvent('custom_record.created', ev(), scopes({ customView: [99] })).deliver).toBe(false);
    expect(evaluateEvent('custom_record.created', ev(), scopes({ customView: [7] })).deliver).toBe(true);
  });

  it('che SĐT trường phone + dãy số trong văn bản khi thiếu custom_records.phone_full; đủ quyền thì giữ nguyên', () => {
    const masked = evaluateEvent('custom_record.updated', ev(), scopes({ customPhoneFull: null }));
    const d = (masked.data.record as { data: Record<string, unknown> }).data;
    expect(d.sdt).toBe('***678');
    expect(d.ghi_chu).toBe('gọi ***321 nhé');
    expect(d.ten).toBe('Lan');
    expect(JSON.stringify(masked.data)).not.toContain('0912345678');
    const shown = evaluateEvent('custom_record.updated', ev(), scopes({ customPhoneFull: 'all' }));
    expect((shown.data.record as { data: Record<string, unknown> }).data.sdt).toBe('0912345678');
  });

  it('phone_full của contacts KHÔNG mở SĐT bản ghi tuỳ biến', () => {
    const r = evaluateEvent('custom_record.created', ev(), scopes({ phoneFull: 'all', customPhoneFull: null }));
    expect((r.data.record as { data: Record<string, unknown> }).data.sdt).toBe('***678');
  });

  it('visible_role_ids: chỉ chủ endpoint thuộc vai trò (hoặc giữ custom_objects.manage) mới nhận; thực thể tắt không gửi', () => {
    const restricted = ev({}, { visible_role_ids: [3] });
    expect(evaluateEvent('custom_record.created', restricted, scopes({ roleIds: [4] })).deliver).toBe(false);
    expect(evaluateEvent('custom_record.created', restricted, scopes({ roleIds: [3] })).deliver).toBe(true);
    expect(evaluateEvent('custom_record.created', restricted, scopes({ roleIds: [], canManageCustomObjects: true })).deliver).toBe(true);
    expect(evaluateEvent('custom_record.created', ev({}, { is_active: false }), scopes()).deliver).toBe(false);
  });
});

describe('evaluateEvent — Messenger, bình luận, đăng bài', () => {
  const msg = { conversation_id: 3, page_id: 'P', contact_id: 11, contact_assigned_to: 7, origin: 'customer' };
  it('tin Messenger / bình luận: theo phạm vi xem khách', () => {
    expect(evaluateEvent('messenger.message_received', msg, scopes()).deliver).toBe(true);
    expect(evaluateEvent('messenger.message_sent', msg, scopes({ contactsView: [7] })).deliver).toBe(true);
    expect(evaluateEvent('messenger.message_received', msg, scopes({ contactsView: [99] })).deliver).toBe(false);
    const c = { comment_id: 1, page_id: 'P', post_id: 'P_1', contact_id: null, contact_assigned_to: null, auto_reply_status: 'received' };
    expect(evaluateEvent('facebook.comment_received', c, scopes()).deliver).toBe(true);
    expect(evaluateEvent('facebook.comment_received', c, scopes({ contactsView: [7] })).deliver).toBe(false);
  });
  it('gửi hàng loạt: luôn gửi, che SĐT trong tên lượt khi thiếu phone_full', () => {
    const b = { broadcast_id: 2, page_id: 'P', name: 'Gọi 0912345678', status: 'done', total: 3, sent: 2, failed: 0, skipped: 1 };
    expect(evaluateEvent('messenger.broadcast_finished', b, scopes()).data.name).toBe('Gọi 0912345678');
    expect(evaluateEvent('messenger.broadcast_finished', b, scopes({ phoneFull: [7] })).data.name).toBe('Gọi ***678');
  });
  it('đăng bài: chỉ khi có social.post', () => {
    const p = { post_id: 1, target_id: 2, network: 'youtube', account_id: 5, url: 'u', error: null };
    expect(evaluateEvent('social_post.published', p, scopes()).deliver).toBe(false);
    expect(evaluateEvent('social_post.failed', p, scopes({ canSocialPost: true })).deliver).toBe(true);
  });
});

describe('evaluateEvent — store_order.created', () => {
  const order = (assigned: number | null) => ({
    order: { id: 5, code: 'DH-ABC123', customer_name: 'Chị B 0912345678', customer_phone: '0912345678', customer_address: '12 Lê Lợi', note: 'gọi 0987654321', total: 150000, contact_assigned_to: assigned },
  });

  it('chủ endpoint xem được đơn + SĐT ⇒ nhận nguyên', () => {
    const r = evaluateEvent('store_order.created', order(7), scopes());
    expect((r.data.order as Record<string, unknown>).customer_phone).toBe('0912345678');
  });

  it('không có phone_full ⇒ che SĐT người mua và số lẫn trong tên/ghi chú', () => {
    const o = evaluateEvent('store_order.created', order(7), scopes({ phoneFull: [] })).data.order as Record<string, unknown>;
    expect(o.customer_phone).toBe('***678');
    expect(String(o.customer_name)).not.toContain('0912345678');
    expect(String(o.note)).not.toContain('0987654321');
  });

  it('ngoài phạm vi deals.view ⇒ không gửi; đơn chưa ghép khách chỉ tới phạm vi "tất cả"', () => {
    expect(evaluateEvent('store_order.created', order(7), scopes({ dealsView: [9] })).deliver).toBe(false);
    expect(evaluateEvent('store_order.created', order(null), scopes({ dealsView: [9] })).deliver).toBe(false);
    expect(evaluateEvent('store_order.created', order(null), scopes()).deliver).toBe(true);
  });
});
