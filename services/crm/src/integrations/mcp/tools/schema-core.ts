import { can } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { CORE_EXTRAS, CORE_PERMS, scopeName, type CoreKey } from './core-records';
import type { FieldDescription } from './schema-tools';

type On = ('create' | 'update')[];
type CoreField = FieldDescription & { settable_on: On };

const f = (key: string, label: string, type: string, settable_on: On, required = false, help?: string): CoreField => ({
  key, label, type, required, unique: false, is_title: key === 'full_name' || key === 'title', read_only: settable_on.length === 0, help_text: help ?? null, settable_on,
});

interface CoreTable {
  key: CoreKey;
  describe: (user: AuthUser) => Record<string, unknown> | null;
}

const CORE_PREFIX: Record<CoreKey, string> = { contacts: 'KH', deals: 'DL', tasks: 'CV' };

function core(key: CoreKey, label: string, fields: CoreField[], note: string, filters: string[]): CoreTable {
  const perms = CORE_PERMS[key];
  return {
    key,
    describe: (user) => {
      if (!can(user.grants, perms.view)) return null;
      const canCreate = can(user.grants, perms.create);
      const canUpdate = can(user.grants, perms.update);
      return {
        key, label, label_plural: label, kind: 'core', description: note, is_active: true, code_prefix: CORE_PREFIX[key], code_example: `${CORE_PREFIX[key]}001`,
        permissions: { view: true, create: canCreate, update: canUpdate },
        data_scope: scopeName(user.grants[perms.view]),
        fields, filters,
        // Khoá phụ CHỈ ĐỌC mà list_records/get_record trả thêm (không ghi được); mọi khoá còn lại trong bản ghi trùng `fields[].key`.
        read_only_fields: Object.entries(CORE_EXTRAS[key]).map(([k, help]) => ({ key: k, help })),
        tools: { read: ['list_records', 'get_record'], write: [...(canCreate ? ['create_record'] : []), ...(canUpdate ? ['update_record'] : [])] },
      };
    },
  };
}

/**
 * Bảng LÕI (khách hàng, deal, việc): đọc/ghi bằng list_records/get_record/create_record/update_record — các tool này gửi sang đúng
 * service nghiệp vụ của giao diện web (phạm vi, che SĐT, activity, outbox giữ nguyên). Danh sách trường là phần AI được đọc/ghi.
 */
export const CORE_TABLES: readonly CoreTable[] = [
  core('contacts', 'Khách hàng', [
    f('full_name', 'Họ tên', 'text', ['create', 'update'], true), f('phone', 'SĐT (luôn bị che với AI; chỉ nhập khi tạo)', 'phone', ['create'], true),
    f('source_id', 'Nguồn', 'option', ['create', 'update'], true, 'id từ list_crm_options'), f('stage_id', 'Giai đoạn', 'option', ['create', 'update'], false, 'id từ list_crm_options'),
    f('contact_status_id', 'Trạng thái', 'option', ['update'], false, 'id từ list_crm_options'), f('assigned_to', 'Người phụ trách (đổi bằng assign_contact)', 'user', []),
    f('job_title', 'Nghề nghiệp', 'text', ['create', 'update']), f('company_name', 'Công ty', 'text', ['create', 'update']), f('email', 'Email', 'email', ['create', 'update']),
    f('reminder_at', 'Hẹn nhắc', 'datetime', ['update']), f('reminder_notes', 'Ghi chú hẹn nhắc', 'long_text', ['update']),
  ], 'Khách hàng: Sale thấy khách mình phụ trách, Trưởng nhóm thấy thêm khách của cấp dưới. Khách tạo mới do chính người dùng phụ trách. Không có tuỳ biến cấu trúc cho bảng lõi — muốn thêm dữ liệu theo ngành hãy tạo bảng tuỳ biến có trường liên kết tới khách hàng.',
  ['stage_id', 'contact_status_id', 'source_id', 'assigned_to', 'uncontacted_days']),
  core('deals', 'Deal', [
    f('title', 'Tiêu đề', 'text', ['create', 'update'], true), f('description', 'Mô tả', 'long_text', ['create', 'update']), f('value', 'Giá trị (VND, số nguyên)', 'currency', ['create', 'update']),
    f('status', 'Trạng thái', 'select', ['create', 'update'], false, 'open | won | lost'), f('note', 'Ghi chú', 'long_text', ['create', 'update']),
    f('assigned_to', 'Người phụ trách (id; mặc định bạn; trong phạm vi quản lý deal của bạn)', 'user', ['create']), f('contact_id', 'Khách hàng', 'relation', ['create']),
  ], 'Thương vụ: Sale thấy deal của mình, Trưởng nhóm thấy thêm của cấp dưới.', ['status', 'assigned_to']),
  core('tasks', 'Việc (Kanban)', [
    f('title', 'Tiêu đề', 'text', ['create', 'update'], true), f('description', 'Mô tả', 'long_text', ['create', 'update']), f('due_at', 'Hạn (ISO 8601)', 'datetime', ['create', 'update']),
    f('priority', 'Ưu tiên', 'select', ['create', 'update']), f('contact_id', 'Khách hàng gắn kèm', 'relation', ['create', 'update']), f('column_id', 'Cột (chỉ khi tạo)', 'option', ['create'], false, 'id từ list_crm_options'),
  ], 'Việc Kanban: tạo mới luôn giao cho chính người dùng. Chỉ thấy thẻ trong board và phạm vi của bạn.', ['board_id', 'column_id', 'contact_id', 'assignee_id', 'overdue']),
];
