import { can } from '@trinity/rbac';
import { DATE_TYPES } from '../../../custom-objects/field-types';
import { VIEW_TYPE_INFO } from '../../../custom-objects/view-config';
import { wrapData } from '../ai-output';
import { describeCustomTables } from './schema-tools';
import { CORE_TABLES } from './schema-core';
import { ToolUserError, type ToolDef } from './tool-types';

/** Thứ người dùng hay xin mà Trinity KHÔNG có loại màn tương ứng — nêu thẳng để AI không hứa hẹn. */
export const NOT_SUPPORTED_SCREENS = 'biểu đồ / chart, dashboard tuỳ biến, gantt / timeline, bản đồ / map, 3D, form tuỳ biến, trang HTML tuỳ ý';

/**
 * Danh mục loại màn (view) Trinity render được + trường cần cho từng loại. Có `object` ⇒ thêm trường của bảng đó hợp
 * cho từng loại (kanban: trường select; calendar: trường date/datetime) để AI đưa người dùng chọn. Chỉ đọc.
 */
export const listScreenTypesTool: ToolDef = {
  name: 'list_screen_types',
  title: 'Các loại màn hình hỗ trợ / List supported screen types',
  description:
    'Danh sách các loại màn (giao diện) Trinity tạo được cho một bảng tuỳ biến: list (danh sách), kanban, calendar (lịch), table (bảng sửa nhanh) — mỗi loại có mô tả, hợp với việc gì và trường bắt buộc ' +
    '(kanban cần một trường lựa chọn/select cho group_by; calendar cần một trường ngày/ngày giờ cho date_field). ' +
    'Truyền object (khoá bảng) để nhận thêm các trường của bảng đó dùng được cho từng loại. Đây là các lựa chọn để người dùng chọn loại màn khi họ chưa nói rõ; loại ngoài danh sách không tạo được. Chỉ đọc. / ' +
    'Lists the screen (view) types Trinity can create for a custom table — list, kanban, calendar, table — with what each looks like and which fields it needs; with object, also the matching fields of that table. ' +
    'These are the options offered to the user when they have not said which type they want; other types cannot be created. Read-only.',
  permissions: [],
  input: (z) => ({ object: z.string().min(1).max(48).optional().describe('Khoá bảng (từ describe_schema) để gợi ý trường hợp lệ cho từng loại / Table key for field suggestions') }),
  output: (z) => ({ notice: z.string(), data: z.record(z.string(), z.unknown()) }),
  async run(args, { deps, principal }) {
    const user = principal.user;
    const data: Record<string, unknown> = {
      screen_types: VIEW_TYPE_INFO.map((i) => ({ type: i.type, name: i.name, summary: i.summary, requires: i.requires, optional: i.optional, good_for: i.good_for })),
      not_supported: NOT_SUPPORTED_SCREENS,
      applies_to: 'Bảng tuỳ biến (kind=custom trong describe_schema). Bảng lõi contacts / deals / tasks dùng màn có sẵn của Trinity, không thêm màn mới được; cần màn riêng cho loại dữ liệu đó thì dựng bảng tuỳ biến. / Custom tables only.',
      create_with: 'create_view (một màn) hoặc propose_workspace.views (khi dựng cả gói); sửa: update_view; đưa lên menu: show_in_nav hoặc set_menu.',
      can_create: can(user.grants, 'custom_objects.manage'),
    };
    const key = typeof args.object === 'string' ? args.object.trim() : '';
    if (key) {
      if (CORE_TABLES.some((t) => t.key === key)) {
        data.object = { key, kind: 'core', note: 'Bảng lõi: không tạo thêm màn được. / Core table: no custom screens.' };
      } else {
        const [t] = await describeCustomTables(deps, user, key);
        if (!t) throw new ToolUserError(`Không có bảng “${key.slice(0, 48)}” (hoặc bạn không được thấy). Gọi describe_schema để lấy khoá bảng.`);
        const pick = (ok: (type: string) => boolean) => t.fields.filter((f) => ok(f.type)).map((f) => ({ key: f.key, label: f.label, type: f.type }));
        const selects = pick((x) => x === 'select');
        const dates = pick((x) => (DATE_TYPES as readonly string[]).includes(x));
        data.object = {
          key: t.key, label: t.label, existing_screens: t.views,
          list_table_columns: 'mọi trường của bảng (columns tuỳ chọn)',
          kanban_group_by_fields: selects,
          calendar_date_fields: dates,
          ...(selects.length ? {} : { kanban_missing: 'Bảng chưa có trường lựa chọn (select) — cần thêm một trường select (add_field) trước khi tạo kanban.' }),
          ...(dates.length ? {} : { calendar_missing: 'Bảng chưa có trường ngày (date/datetime) — cần thêm một trường ngày (add_field) trước khi tạo lịch.' }),
        };
      }
    }
    const out = wrapData(data);
    return { structured: out, text: JSON.stringify(out) };
  },
};
