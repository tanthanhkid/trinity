import { actionToolByName, ACTION_TOOLS } from '../actions/action-registry';
import type { ActionToolDef } from '../actions/action-types';
import { wrapData } from '../ai-output';
import { ActionUserError } from '../actions/action-types';
import { errorPreview, type RowError } from '../actions/import-custom';
import { ToolUserError, type ToolDef } from './tool-types';

const ACTION_OUT = (z: import('./tool-types').Z) => ({
  notice: z.string(),
  data: z.object({
    action_id: z.number(),
    /** `executed` = đã thực hiện xong; `pending` = đang chờ người dùng duyệt (chỉ khi workspace bật "Yêu cầu duyệt thay đổi do AI"). */
    status: z.string(),
    summary: z.string(),
    message: z.string(),
    result: z.record(z.string(), z.unknown()).optional(),
    expires_at: z.string().optional(),
    review_url: z.string().optional(),
    duplicate: z.boolean().optional(),
  }),
});

/** Kết quả có `errors` [{row, reason}] (vd import_records) ⇒ nêu vài dòng lỗi đầu ngay trong message cho AI. */
function rowErrorNote(result: Record<string, unknown> | undefined): string {
  const errs = Array.isArray(result?.errors) ? (result.errors as RowError[]) : [];
  if (errs.length === 0) return '';
  const total = typeof result?.error_total === 'number' ? result.error_total : errs.length;
  return `. ${total} dòng lỗi không ghi: ${errorPreview(errs)}${total > 3 ? ' … (xem result.errors)' : ''}`;
}

/**
 * Mỗi thao tác ghi = 1 tool. Mặc định CHẠY NGAY với quyền của người dùng đã kết nối (cùng kiểm quyền/phạm vi/DTO với luồng duyệt);
 * khi workspace bật "Yêu cầu duyệt thay đổi do AI" thì chỉ tạo bản nháp, người dùng duyệt trên web mới có hiệu lực.
 */
function writeTool(a: ActionToolDef): ToolDef {
  return {
    name: a.name,
    title: a.title,
    description: `${a.description} Cần scope crm.write; chạy ngay theo quyền của người dùng và trả về kết quả thật (nếu workspace bật chế độ duyệt thì trả action_id chờ duyệt — dùng get_action_status để hỏi lại).`,
    permissions: a.permissions,
    scope: 'crm.write',
    annotations: { readOnlyHint: false, destructiveHint: a.destructive, idempotentHint: a.idempotent },
    input: a.input,
    output: ACTION_OUT,
    async run(args, { deps, principal }) {
      try {
        if (await deps.actions.requiresApproval()) {
          const d = await deps.actions.createDraft(a, args, principal);
          const message = `Đã tạo đề xuất #${d.id}, chờ người dùng duyệt tại ${d.review_url}. Thao tác chưa được thực hiện cho tới khi người dùng duyệt.`;
          const out = wrapData({ action_id: d.id, status: d.status, summary: d.summary, expires_at: d.expires_at.toISOString(), review_url: d.review_url, message, duplicate: d.duplicate });
          return { structured: out, text: JSON.stringify(out) };
        }
        const d = await deps.actions.executeNow(a, args, principal);
        const message = `Đã thực hiện: ${d.summary}${rowErrorNote(d.result)}`;
        const out = wrapData({ action_id: d.id, status: d.status, summary: d.summary, result: d.result, message });
        return { structured: out, text: JSON.stringify(out) };
      } catch (err) {
        if (err instanceof ActionUserError) throw new ToolUserError(err.message);
        throw err;
      }
    },
  };
}

export const statusTool: ToolDef = {
  name: 'get_action_status',
  title: 'Trạng thái thao tác / Get action status',
  description:
    'Hỏi lại trạng thái một thao tác ghi: truyền action_id (số mà tool ghi đã trả về). Trạng thái: executed (đã thực hiện) / failed, hoặc khi workspace bật chế độ duyệt: pending (chờ duyệt) / approved / rejected / expired. Kèm kết quả. Chỉ thấy thao tác do chính kết nối này tạo. / Check the status of a write action you made.',
  permissions: [],
  input: (z) => ({
    action_id: z.number().int().min(1).max(2_147_483_647).optional().describe('action_id mà tool ghi đã trả về / Action id returned by the write tool'),
    id: z.number().int().min(1).max(2_147_483_647).optional().describe('(Tên cũ của action_id — vẫn nhận để tương thích) / Deprecated alias of action_id'),
  }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const pos = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);
    const id = pos(args.action_id) || pos(args.id);
    if (!id) throw new ToolUserError('Cần action_id (số nguyên dương) — lấy từ kết quả của tool ghi.');
    if (pos(args.action_id) && pos(args.id) && pos(args.action_id) !== pos(args.id)) throw new ToolUserError('action_id và id khác nhau — chỉ gửi action_id.');
    const out = wrapData(await deps.actions.statusFor(principal, id));
    return { structured: out, text: JSON.stringify(out) };
  },
};

export const WRITE_TOOLS: readonly ToolDef[] = [...ACTION_TOOLS.map(writeTool), statusTool];
export { actionToolByName };
