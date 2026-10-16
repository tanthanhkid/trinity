import { wrapData } from '../ai-output';
import { ToolUserError, type ToolDef } from './tool-types';

/** Tương tác gộp: bình luận Fanpage + hội thoại Messenger + Zalo OA, kèm luật đã chạy và trạng thái trả lời. Chỉ đọc. */
export const listInteractionsTool: ToolDef = {
  name: 'list_interactions',
  title: 'Tương tác gần đây (bình luận + tin nhắn) / Recent interactions',
  description:
    'Liệt kê tương tác của khách theo thời gian, mới nhất trước: bình luận dưới bài Fanpage, hội thoại Messenger, hội thoại Zalo OA. ' +
    'Mỗi mục có kênh, loại (comment/message), tên khách, nội dung, link bài (bình luận), luật đã chạy và kết quả, trạng thái ' +
    '(unanswered = chưa ai trả lời, auto = luật đã trả lời, staff = nhân viên đã trả lời, answered = Page đã trả lời). ' +
    'Lọc: channel (facebook/zalo; Zalo OA chỉ có tin nhắn), type (comment/message), status=unanswered (cả bình luận lẫn tin nhắn), has_rule (chỉ áp cho bình luận), from/to (YYYY-MM-DD), q (tìm gần đúng tên/nội dung). ' +
    'Mặc định 30 mục mới nhất, mọi ngày. Kèm stats hôm nay (giờ VN). Chi tiết từng việc luật đã làm với một bình luận: list_facebook_comments. Dùng để tóm tắt "hôm nay khách hỏi gì" hoặc tìm việc chưa trả lời. Chỉ thấy kênh hợp quyền người dùng. Chỉ đọc. / ' +
    'Lists recent customer interactions (Fanpage comments, Messenger and Zalo OA conversations) with rule results and reply status. Read-only.',
  permissions: [],
  input: (z) => ({
    channel: z.enum(['facebook', 'zalo']).optional().describe('Kênh / Channel'),
    type: z.enum(['comment', 'message']).optional().describe('Loại / Type'),
    status: z.enum(['unanswered']).optional().describe('unanswered = chỉ việc chưa ai trả lời / only unanswered'),
    has_rule: z.boolean().optional().describe('true = bình luận có luật chạy; false = không có luật / comments handled by a rule or not'),
    from: z.string().max(40).optional().describe('Từ ngày YYYY-MM-DD (giờ VN, tính từ đầu ngày) / From date'),
    to: z.string().max(40).optional().describe('Đến ngày YYYY-MM-DD (giờ VN, tính hết ngày) / To date'),
    q: z.string().max(100).optional().describe('Tìm theo tên khách hoặc nội dung / Search'),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    if (!deps.interactions) throw new ToolUserError('Máy chủ chưa bật mục Tương tác. / Not available on this server.');
    // Ngày không kèm giờ (2026-10-16) = cả ngày theo giờ VN: from từ 00:00, to tới 23:59:59.
    const d = (v: unknown, end = false) => {
      if (typeof v !== 'string' || !v) return undefined;
      const x = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59' : '00:00:00'}+07:00` : v);
      if (Number.isNaN(x.getTime())) throw new ToolUserError(`Ngày không hợp lệ: ${v}. Dùng dạng 2026-10-16. / Invalid date.`);
      return x;
    };
    const g = principal.user.grants;
    const [list, stats] = await Promise.all([
      deps.interactions.list(g, {
        channel: args.channel as never, type: args.type as never, status: args.status as never,
        has_rule: typeof args.has_rule === 'boolean' ? args.has_rule : undefined,
        from: d(args.from), to: d(args.to, true), q: typeof args.q === 'string' ? args.q : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 30,
      }),
      deps.interactions.stats(g),
    ]);
    const out = wrapData({ stats_today: { messages: stats.messages_today, comments: stats.comments_today, auto_handled: stats.auto_handled_today, unanswered_last_7_days: stats.unanswered_7d }, items: list.data.map(({ ref: _ref, ...rest }) => rest), more: !!list.next_before, manage_url: '/inbox?kenh=tuong-tac' });
    return { structured: out, text: JSON.stringify(out) };
  },
};
