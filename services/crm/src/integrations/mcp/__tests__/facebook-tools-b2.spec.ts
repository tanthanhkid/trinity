import { BadRequestException } from '@nestjs/common';
import { createCommentRuleTool, testCommentRuleTool, updateCommentRuleTool } from '../tools/facebook-comment-tools';
import { updateMessageFlowTool } from '../tools/facebook-flow-tools';
import { updateMessengerBroadcastTool } from '../tools/facebook-broadcast-tools';
import { ToolUserError } from '../tools/tool-types';

const principal = { user: { userId: 7 } } as never;
const rule = (o: Record<string, unknown> = {}) => ({
  id: 3, name: 'Hỏi giá', page_id: null, post_id: null, keywords: ['giá'], exclude_keywords: [], public_replies: ['Đã nhắn {ten}'], private_reply: 'Chào {ten}',
  hide_if_phone: false, once_per_user: true, mode: 'test', is_active: true, position: 0, ...o,
});

function deps(o: { rules?: unknown[] } = {}) {
  const facebookComments = {
    listRules: jest.fn(async () => o.rules ?? [rule()]),
    createRule: jest.fn(async (input: any) => rule({ ...input, id: 9 })),
    updateRule: jest.fn(async (id: number, input: any) => rule({ ...(o.rules?.[0] as object), ...input, id })),
    dryRun: jest.fn(async () => ({ matched_rule: { id: 3, name: 'Hỏi giá', mode: 'test' }, phone_found: null, actions: {} })),
  };
  const facebookFlows = { update: jest.fn(async (id: number, input: any) => ({ id, name: 'K', page_name: 'P', page_id: '1', trigger: 'keyword', keywords: [], is_active: input.is_active ?? false, steps: [], starts: 0, completes: 0, running: 0 })) };
  const cur = { id: 4, name: 'Khai giảng', page_id: '1', page_name: 'P', text: 'Cũ', status: 'scheduled', scheduled_at: new Date(Date.now() + 3_600_000), total: 0, sent: 0, failed: 0, skipped: 0, audience: { source_ids: [2] } };
  const facebookBroadcasts = {
    get: jest.fn(async () => cur),
    validate: jest.fn(async () => ({})),
    preview: jest.fn(async () => ({ eligible: 3, outside_window: 1, sample: ['An'] })),
    update: jest.fn(async (_id: number, input: any) => ({ ...cur, ...input })),
    send: jest.fn(async () => ({ ...cur, status: 'scheduled' })),
    kick: jest.fn(),
    sendTime: jest.fn((at?: string | null) => {
      if (at && Date.parse(at) > Date.now() + 7 * 86_400_000) throw new BadRequestException('Hẹn tối đa 7 ngày tới');
      return new Date();
    }),
  };
  return {
    facebookComments, facebookFlows, facebookBroadcasts,
    orgFeatures: { isEnabled: jest.fn(async () => true) },
    prisma: { facebookPage: { findMany: jest.fn(async () => [{ page_id: '1', name: 'P' }]), findUnique: jest.fn(async ({ where }: any) => (['1', '2', '111'].includes(where.page_id) ? { page_id: where.page_id } : null)) } },
  } as any;
}
const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example', principal }) as never;

describe('create_comment_rule', () => {
  it('mặc định chế độ thử ⇒ lưu ngay, không cần đồng ý', async () => {
    const d = deps();
    const r = await createCommentRuleTool.run({ name: 'Hỏi giá', keywords: ['giá'], hide_if_phone: true }, ctx(d));
    expect(d.facebookComments.createRule).toHaveBeenCalledWith(expect.objectContaining({ name: 'Hỏi giá', mode: 'test', is_active: true, hide_if_phone: true }), 7);
    expect((r.structured as any).data.saved).toBe(true);
  });

  it('chạy thật thiếu lời đồng ý ⇒ chỉ trả bản xem trước; có đồng ý ⇒ lưu', async () => {
    const d = deps();
    const r = await createCommentRuleTool.run({ name: 'X', public_replies: ['Đã inbox'], mode: 'live' }, ctx(d));
    expect((r.structured as any).data.saved).toBe(false);
    expect(d.facebookComments.createRule).not.toHaveBeenCalled();
    await createCommentRuleTool.run({ name: 'X', public_replies: ['Đã inbox'], mode: 'live', confirmed_by_user: 'ok bật đi' }, ctx(d));
    expect(d.facebookComments.createRule).toHaveBeenCalledWith(expect.objectContaining({ mode: 'live' }), 7);
  });

  it('không có việc gì để làm ⇒ báo lỗi', async () => {
    await expect(createCommentRuleTool.run({ name: 'X', keywords: ['a'] }, ctx(deps()))).rejects.toBeInstanceOf(ToolUserError);
  });
});

describe('update_comment_rule', () => {
  it('tắt luật đang chạy thật ⇒ lưu ngay', async () => {
    const d = deps({ rules: [rule({ mode: 'live' })] });
    await updateCommentRuleTool.run({ rule_id: 3, active: false }, ctx(d));
    expect(d.facebookComments.updateRule).toHaveBeenCalledWith(3, { is_active: false });
  });

  it('đổi câu trả lời của luật đang chạy thật ⇒ cần đồng ý; chỉ đổi tên thì không', async () => {
    const d = deps({ rules: [rule({ mode: 'live' })] });
    const r = await updateCommentRuleTool.run({ rule_id: 3, public_replies: ['Mới'] }, ctx(d));
    expect((r.structured as any).data.saved).toBe(false);
    expect(d.facebookComments.updateRule).not.toHaveBeenCalled();
    await updateCommentRuleTool.run({ rule_id: 3, name: 'Tên mới' }, ctx(d));
    expect(d.facebookComments.updateRule).toHaveBeenCalledWith(3, { name: 'Tên mới' });
  });

  it('chuyển luật thử sang chạy thật cần đồng ý', async () => {
    const d = deps();
    const r = await updateCommentRuleTool.run({ rule_id: 3, mode: 'live' }, ctx(d));
    expect((r.structured as any).data.saved).toBe(false);
    await updateCommentRuleTool.run({ rule_id: 3, mode: 'live', confirmed_by_user: 'đồng ý chạy thật' }, ctx(d));
    expect(d.facebookComments.updateRule).toHaveBeenCalledWith(3, { mode: 'live' });
  });

  it('luật áp một bài mà đổi Page không kèm post_link ⇒ báo, không để luật chết im', async () => {
    const d = deps({ rules: [rule({ page_id: '1', post_id: '1_99' })] });
    await expect(updateCommentRuleTool.run({ rule_id: 3, page_id: '2' }, ctx(d))).rejects.toThrow(/post_link/);
    await updateCommentRuleTool.run({ rule_id: 3, page_id: '2', post_link: null }, ctx(d));
    expect(d.facebookComments.updateRule).toHaveBeenCalledWith(3, { page_id: '2', post_id: null });
  });

  it('chỉ gửi post_link dạng /posts/<số> ⇒ ghép theo Page đang có của luật', async () => {
    const d = deps({ rules: [rule({ page_id: '111' })] });
    await updateCommentRuleTool.run({ rule_id: 3, post_link: 'https://www.facebook.com/trang/posts/123456789' }, ctx(d));
    expect(d.facebookComments.updateRule).toHaveBeenCalledWith(3, { post_id: '111_123456789' });
  });

  it('sửa xong không còn việc nào mà luật đang bật ⇒ từ chối', async () => {
    const d = deps({ rules: [rule({ private_reply: null })] });
    await expect(updateCommentRuleTool.run({ rule_id: 3, public_replies: [] }, ctx(d))).rejects.toThrow(/không còn việc/);
    await updateCommentRuleTool.run({ rule_id: 3, public_replies: [], active: false }, ctx(d));
    expect(d.facebookComments.updateRule).toHaveBeenCalledWith(3, { public_replies: [], is_active: false });
  });

  it('bài thuộc Page khác / Page chưa kết nối / câu trả lời toàn khoảng trắng ⇒ từ chối', async () => {
    await expect(createCommentRuleTool.run({ name: 'X', page_id: '111', post_link: '22222_33333', hide_if_phone: true }, ctx(deps()))).rejects.toThrow(/Fanpage khác/);
    await expect(createCommentRuleTool.run({ name: 'X', page_id: '999', hide_if_phone: true }, ctx(deps()))).rejects.toThrow(/page_id = 999/);
    await expect(createCommentRuleTool.run({ name: 'X', public_replies: [' '] }, ctx(deps()))).rejects.toBeInstanceOf(ToolUserError);
    const d = deps({ rules: [rule({ private_reply: null })] });
    await expect(updateCommentRuleTool.run({ rule_id: 3, public_replies: [' '] }, ctx(d))).rejects.toThrow(/không còn việc/);
  });

  it('rule_id không có ⇒ báo rõ', async () => {
    await expect(updateCommentRuleTool.run({ rule_id: 99, active: false }, ctx(deps()))).rejects.toThrow(/rule_id = 99/);
  });

  it('lỗi kiểm dữ liệu của service ⇒ lỗi cho người dùng', async () => {
    const d = deps();
    d.facebookComments.updateRule.mockRejectedValueOnce(new BadRequestException('Không đọc được bài từ link này'));
    await expect(updateCommentRuleTool.run({ rule_id: 3, post_link: 'pfbid0x' }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
  });
});

describe('test_comment_rule', () => {
  it('chạy thử không ghi gì', async () => {
    const d = deps();
    const r = await testCommentRuleTool.run({ message: 'giá bao nhiêu', post_link: '123_456' }, ctx(d));
    expect(d.facebookComments.dryRun).toHaveBeenCalledWith({ message: 'giá bao nhiêu', page_id: null, post_id: '123_456', from_name: null });
    expect((r.structured as any).data.matched_rule.id).toBe(3);
  });
});

describe('kiểm sớm trước bản xem trước', () => {
  it('link bài không đọc được ⇒ báo ngay, kể cả khi chưa đồng ý', async () => {
    await expect(createCommentRuleTool.run({ name: 'X', public_replies: ['a'], post_link: 'https://facebook.com/share/p/pfbid0abc', mode: 'live' }, ctx(deps()))).rejects.toBeInstanceOf(ToolUserError);
  });

  it('hẹn gửi hàng loạt quá 7 ngày ⇒ báo ngay', async () => {
    const far = new Date(Date.now() + 10 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 16);
    await expect(updateMessengerBroadcastTool.run({ broadcast_id: 4, scheduled_at: far }, ctx(deps()))).rejects.toThrow(/7 ngày/);
  });
});

describe('update_message_flow', () => {
  it('chỉ gửi trường đổi; bật/tắt bằng active', async () => {
    const d = deps();
    await updateMessageFlowTool.run({ flow_id: 5, active: true }, ctx(d));
    expect(d.facebookFlows.update).toHaveBeenCalledWith(5, { is_active: true });
    await expect(updateMessageFlowTool.run({ flow_id: 5 }, ctx(d))).rejects.toBeInstanceOf(ToolUserError);
  });
});

describe('update_messenger_broadcast', () => {
  it('thiếu đồng ý ⇒ xem trước, không sửa; có đồng ý ⇒ sửa và giữ bộ lọc cũ khi chỉ đổi một bộ lọc', async () => {
    const d = deps();
    const r = await updateMessengerBroadcastTool.run({ broadcast_id: 4, text: 'Mới', chat_link_ids: [8] }, ctx(d));
    expect((r.structured as any).data.saved).toBe(false);
    expect(d.facebookBroadcasts.update).not.toHaveBeenCalled();
    expect(d.facebookBroadcasts.preview).toHaveBeenCalledWith('1', { source_ids: [2], chat_link_ids: [8] });
    await updateMessengerBroadcastTool.run({ broadcast_id: 4, text: 'Mới', chat_link_ids: [8], confirmed_by_user: 'ok sửa đi' }, ctx(d));
    expect(d.facebookBroadcasts.update).toHaveBeenCalledWith(4, { text: 'Mới', audience: { source_ids: [2], chat_link_ids: [8] } });
    expect(d.facebookBroadcasts.send).not.toHaveBeenCalled();
  });

  it('gửi ngay ⇒ send + kick; lượt đã chạy ⇒ không sửa được', async () => {
    const d = deps();
    await updateMessengerBroadcastTool.run({ broadcast_id: 4, send_now: true, confirmed_by_user: 'ok gửi đi' }, ctx(d));
    expect(d.facebookBroadcasts.send).toHaveBeenCalledWith(4, null);
    expect(d.facebookBroadcasts.kick).toHaveBeenCalled();
    d.facebookBroadcasts.get.mockResolvedValueOnce({ id: 4, status: 'done', audience: {} });
    await expect(updateMessengerBroadcastTool.run({ broadcast_id: 4, text: 'x', confirmed_by_user: 'ok' }, ctx(d))).rejects.toThrow(/không sửa được/);
  });
});
