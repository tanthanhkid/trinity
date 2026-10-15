import { wrapData } from '../ai-output';
import { ForbiddenToolError, ToolUserError, type ToolContext, type ToolDef, type Z } from './tool-types';

/** Bản tin agent viết: đủ dài cho một bản tin, không phình nhật ký kiểm toán. */
export const BRIEFING_TEXT_MAX = 6000;
const TITLE_MAX = 200;

type Slot = 'morning' | 'evening';
const nowSlot = (): Slot => (new Date(Date.now() + 7 * 3600_000).getUTCHours() < 12 ? 'morning' : 'evening');
const slotOf = (v: unknown): Slot => (v === 'morning' || v === 'evening' ? v : nowSlot());
const slotInput = (z: Z) => z.enum(['morning', 'evening']).optional().describe('morning = bản tin sáng (số liệu hôm qua), evening = bản tin chiều (hôm nay tới giờ). Bỏ trống = theo giờ VN hiện tại / Slot');

async function assertFeature(ctx: ToolContext): Promise<void> {
  if (!(await ctx.deps.briefings.featureOn())) throw new ForbiddenToolError('Tính năng Bản tin sáng/chiều đang tắt cho tổ chức này (Cài đặt › Tính năng). / Briefings are disabled for this organisation.');
}

/**
 * Dữ liệu bản tin sáng/chiều cho AGENT của khách tự viết (Trinity không tự gọi AI).
 * Cùng phạm vi quyền `reports.overview` với màn Tổng quan: Sale thấy của mình, Trưởng nhóm thấy nhóm, Giám đốc thấy cả công ty.
 */
export const getBriefingDataTool: ToolDef = {
  name: 'get_briefing_data',
  title: 'Dữ liệu bản tin sáng/chiều / Get briefing data',
  description:
    'Lấy DỮ LIỆU để bạn viết bản tin sáng/chiều cho người dùng: số liệu (khách mới, đổi giai đoạn, deal tạo/thắng/thua, doanh số, việc quá hạn, lịch hẹn nhắc, so với kỳ trước, người nổi bật) ' +
    'kèm danh sách chi tiết (khách mới, việc quá hạn, khách có lịch hẹn nhắc, lead nóng/ấm cần liên hệ) và một bản mẫu dựng sẵn để tham khảo. Theo phạm vi quyền báo cáo của người dùng. ' +
    'Viết xong gọi save_briefing để lưu vào Trinity. Chỉ đọc. / Data for writing the morning/evening briefing within the user\'s reporting scope. Read-only.',
  permissions: ['reports.overview'],
  input: (z) => ({ slot: slotInput(z) }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, ctx) {
    await assertFeature(ctx);
    const res = await ctx.deps.briefings.agentData(ctx.principal.user, slotOf(args.slot));
    if (!res) throw new ForbiddenToolError('Bạn không có phạm vi báo cáo Tổng quan. / No reporting scope.');
    const out = wrapData({ ...res, how_to_save: 'Gọi save_briefing với cùng slot, title và text bạn đã viết. Chỉ dùng số trong dữ liệu này, không bịa.' });
    return { structured: out as unknown as Record<string, unknown>, text: JSON.stringify(out) };
  },
};

/**
 * Lưu bản tin do agent viết — GHI THẲNG (không qua nháp–duyệt): chỉ ghi vào bản tin của CHÍNH người dùng đã kết nối
 * (hộp bản tin cá nhân), không đụng dữ liệu nghiệp vụ. Cùng (slot, ngày) đã có thì thay nội dung.
 */
export const saveBriefingTool: ToolDef = {
  name: 'save_briefing',
  title: 'Lưu bản tin / Save briefing',
  description:
    'Lưu bản tin sáng/chiều bạn đã viết (từ get_briefing_data) vào mục Bản tin của CHÍNH người dùng trong Trinity và báo trong app. ' +
    'Chỉ ghi bản tin của người dùng này, không sửa dữ liệu khách/deal/việc. Gọi lại cùng slot trong ngày thì thay nội dung cũ. Cần scope crm.write. ' +
    '/ Saves the briefing you wrote into the user\'s own Briefings inbox (no CRM business data is changed). Re-saving the same slot replaces it.',
  permissions: ['reports.overview'],
  scope: 'crm.write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: (z) => ({
    slot: slotInput(z),
    title: z.string().min(1).max(TITLE_MAX).describe('Tiêu đề bản tin / Title'),
    text: z.string().min(1).max(BRIEFING_TEXT_MAX).describe('Nội dung bản tin, văn bản thuần (có thể xuống dòng, gạch đầu dòng "- ") / Plain-text body'),
  }),
  output: (z) => ({ notice: z.string(), data: z.object({ briefing_id: z.number(), created: z.boolean(), notified: z.boolean(), url: z.string() }) }),
  async run(args, ctx) {
    await assertFeature(ctx);
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, TITLE_MAX) : '';
    const text = typeof args.text === 'string' ? args.text.trim().slice(0, BRIEFING_TEXT_MAX) : '';
    if (!title || !text) throw new ToolUserError('Cần title và text (không rỗng).');
    let r: { id: number; created: boolean; notified: boolean };
    try {
      r = await ctx.deps.briefings.saveFromAgent(ctx.principal.user, slotOf(args.slot), title, text);
    } catch (err) {
      if (err instanceof Error && err.message.includes('reports.overview')) throw new ForbiddenToolError(err.message);
      throw err;
    }
    const out = wrapData({ briefing_id: r.id, created: r.created, notified: r.notified, url: `${(ctx.baseUrl ?? '').replace(/\/+$/, '')}/briefings?id=${r.id}` });
    return { structured: out, text: JSON.stringify(out) };
  },
};
