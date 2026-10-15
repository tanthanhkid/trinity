import { NotFoundException } from '@nestjs/common';
import { assertInScope } from '@trinity/rbac-nest';
import { loadVisibleObject } from '../../../custom-objects/custom-object-access';
import { isCoreKey } from '../tools/core-records';
import { optInt } from '../tools/tool-types';
import { ActionUserError, type ActionToolDef } from './action-types';
import { cleanText, line, lines, shown } from './action-helpers';

const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
const gone = () => new ActionUserError('Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn.');

/** Xoá MỀM một bản ghi tuỳ biến (đặt `deleted_at`; dữ liệu còn trong DB, khôi phục được bằng cách gỡ cờ). Chỉ bảng tuỳ biến. */
export const archiveRecordAction: ActionToolDef = {
  name: 'archive_record',
  label: 'Lưu trữ (xoá mềm) bản ghi',
  title: 'Lưu trữ bản ghi / Archive a record',
  description:
    'Xoá MỀM (lưu trữ) một bản ghi (id số) của BẢNG TUỲ BIẾN — bản ghi biến khỏi danh sách nhưng dữ liệu không bị huỷ. Không dùng được cho bảng lõi (khách hàng, thương vụ, việc). ' +
    'Cần quyền xoá dữ liệu tuỳ biến trong phạm vi của bạn. Chạy ngay. Gọi get_record trước để chắc đúng bản ghi. / ' +
    'Soft-deletes (archives) one record of a custom table, immediately, within your permissions. Core tables are not supported.',
  permissions: ['custom_records.view', 'custom_records.delete'],
  destructive: true,
  idempotent: true,
  input: (z) => ({
    object: z.string().min(1).max(48).describe('Khoá bảng tuỳ biến (từ describe_schema) / Custom table key'),
    id: z.number().int().min(1).max(2_147_483_647).describe('ID bản ghi / Record id'),
  }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const id = optInt(args.id);
    if (!KEY_RE.test(key) || !id) throw new ActionUserError('object phải là khoá bảng và id là số nguyên dương.');
    if (isCoreKey(key)) throw new ActionUserError('Không lưu trữ được bản ghi của bảng lõi (khách hàng, thương vụ, việc) qua MCP.');
    const def = await loadVisibleObject(deps.prisma, user, key).catch((e: unknown) => {
      if (e instanceof NotFoundException) throw new ActionUserError(`Không có bảng “${key}” (hoặc bạn không được thấy). Hãy gọi describe_schema.`);
      throw e;
    });
    const row = await deps.prisma.customRecord.findFirst({ where: { id, object_id: def.obj.id, deleted_at: null } });
    if (!row) throw gone();
    try {
      await assertInScope(deps.scope, user, 'custom_records.delete', [row.owner_id, row.created_by]);
      await assertInScope(deps.scope, user, 'custom_records.view', [row.owner_id, row.created_by]);
    } catch {
      throw gone();
    }
    const name = `#${id}${row.title ? ` "${row.title}"` : ''}`;
    return { params: { object: key, id }, summary: shown(`Lưu trữ (xoá mềm) ${def.obj.label} ${name}`), details: lines(line('Bảng', def.obj.label_plural), line('Bản ghi', name), line('Hậu quả', 'Bản ghi biến khỏi danh sách; dữ liệu vẫn còn trong hệ thống')) };
  },
  async execute(params, { deps, user }) {
    const key = String(params.object);
    await deps.records.remove(user, key, Number(params.id));
    return { object: key, record_id: Number(params.id), archived: true };
  },
};
