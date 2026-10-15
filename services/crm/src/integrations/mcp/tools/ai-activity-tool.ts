import { can } from '@trinity/rbac';
import { wrapData } from '../ai-output';
import { ForbiddenToolError, ToolUserError, clampLimit, optInt, type ToolDef } from './tool-types';

const STATUSES = ['executed', 'failed', 'pending', 'approved', 'rejected', 'expired'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD). */
export const vnToday = (now = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
/** Đầu ngày YYYY-MM-DD theo giờ VN (+07:00, không đổi giờ mùa hè). */
export const vnDayStart = (d: string): Date => new Date(`${d}T00:00:00+07:00`);

/** Thời điểm theo giờ VN dạng ISO có +07:00 (vd 2026-10-12T18:26:05+07:00) — đọc thẳng ra giờ địa phương. */
export const vnIso = (d: Date | string | null | undefined): string | null => {
  const ms = d == null ? NaN : new Date(d).getTime();
  return Number.isNaN(ms) ? null : `${new Date(ms + 7 * 3_600_000).toISOString().slice(0, 19)}+07:00`;
};

/** Khoảng [from, to) theo giờ VN từ hai ngày (bao gồm cả ngày `to`); mặc định hôm nay; tối đa 92 ngày. */
export function activityRange(fromRaw: unknown, toRaw: unknown, now = new Date()): { from: Date; to: Date; label: string } {
  const today = vnToday(now);
  const f = typeof fromRaw === 'string' && fromRaw.trim() ? fromRaw.trim() : (typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : today);
  const t = typeof toRaw === 'string' && toRaw.trim() ? toRaw.trim() : (typeof fromRaw === 'string' && fromRaw.trim() ? f : today);
  for (const d of [f, t]) if (!DAY.test(d) || Number.isNaN(vnDayStart(d).getTime())) throw new ToolUserError(`Ngày “${d.slice(0, 20)}” không hợp lệ — dùng dạng YYYY-MM-DD.`);
  const from = vnDayStart(f);
  const to = new Date(vnDayStart(t).getTime() + 86_400_000);
  if (to <= from) throw new ToolUserError('from phải trước hoặc bằng to.');
  if (to.getTime() - from.getTime() > 92 * 86_400_000) throw new ToolUserError('Khoảng tối đa 92 ngày.');
  return { from, to, label: f === t ? f : `${f} → ${t}` };
}

/**
 * "AI đã làm gì hôm nay": các thao tác ghi do AI thực hiện (hoặc đề xuất, khi bật chế độ duyệt) — cùng dữ liệu với trang Hoạt động AI.
 * Mặc định: của chính người dùng, hôm nay. Người có integrations.ai_admin xem được cả công ty (all_users=true). Chỉ đọc, scope crm.read.
 */
export const listAiActivityTool: ToolDef = {
  name: 'list_ai_activity',
  title: 'Hoạt động AI: AI đã làm gì / List AI activity',
  description:
    'Danh sách thao tác ghi mà các AI đã làm trong Trinity (tạo/sửa/lưu trữ bản ghi, đổi cấu trúc, tạo màn…) — cùng dữ liệu với trang "Hoạt động AI": thời điểm (giờ Việt Nam, +07:00), người dùng, ứng dụng AI, nội dung, trạng thái (executed/failed, hoặc pending/approved/rejected/expired khi bật chế độ duyệt), kết quả và đường dẫn chi tiết. ' +
    'Mặc định là hôm nay (giờ Việt Nam) và của chính người dùng; from/to (YYYY-MM-DD) chọn khoảng ngày khác. all_users=true là của cả công ty, dành cho người có quyền quản trị kết nối AI (integrations.ai_admin). ' +
    'Lý do lỗi chi tiết chỉ hiện trong Trinity. Chỉ đọc. / ' +
    'Lists the write actions AI apps performed in Trinity (same data as the "AI activity" page): when, who, which AI app, what, status, result and a link. Defaults to today (Vietnam time) and the connected user; from/to pick other dates; all_users=true covers the whole company for AI admins. Read-only.',
  permissions: [],
  input: (z) => ({
    from: z.string().max(10).optional().describe('Từ ngày YYYY-MM-DD (giờ VN); bỏ trống = hôm nay / From date'),
    to: z.string().max(10).optional().describe('Đến hết ngày YYYY-MM-DD; bỏ trống = bằng from (hoặc hôm nay) / To date (inclusive)'),
    all_users: z.boolean().optional().describe('true = mọi người trong công ty (cần integrations.ai_admin); mặc định chỉ của bạn / Whole company'),
    status: z.enum(STATUSES).optional().describe('Lọc theo trạng thái / Status filter'),
    limit: z.number().int().min(1).max(50).optional().describe('Số dòng tối đa (1-50, mặc định 20) / Max rows'),
    cursor: z.number().int().min(1).max(2_147_483_647).optional().describe('next_cursor của trang trước / Pagination cursor'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const all = args.all_users === true;
    if (all && !can(principal.user.grants, 'integrations.ai_admin')) {
      throw new ForbiddenToolError('Xem hoạt động AI của cả công ty cần quyền integrations.ai_admin (quản trị kết nối AI). Bạn vẫn xem được hoạt động AI của chính mình (bỏ all_users). / Company-wide AI activity requires integrations.ai_admin.');
    }
    const range = activityRange(args.from, args.to);
    const status = typeof args.status === 'string' && (STATUSES as readonly string[]).includes(args.status) ? args.status : undefined;
    const r = await deps.actions.activity({ userId: all ? null : principal.userId, from: range.from, to: range.to, status, cursor: optInt(args.cursor), limit: clampLimit(args.limit) });
    const out = wrapData({ range: range.label, timezone: 'Asia/Ho_Chi_Minh', who: all ? 'cả công ty' : 'chính bạn', count_on_page: r.items.length, items: r.items.map((i) => ({ ...i, at: vnIso(i.at) })), next_cursor: r.next_cursor });
    return { structured: out, text: JSON.stringify(out) };
  },
};
