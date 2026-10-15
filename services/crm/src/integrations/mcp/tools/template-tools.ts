import { wrapData } from '../ai-output';
import type { ToolDef } from './tool-types';

/** Đọc danh sách mẫu ngành (chỉ quản trị viên cấu trúc thấy — cùng quyền với cài mẫu). */
export const listTemplatesTool: ToolDef = {
  name: 'list_object_templates',
  title: 'Mẫu bảng theo ngành / List industry templates',
  description:
    'Danh sách MẪU NGÀNH dựng sẵn (khoá, tên, mô tả, các bảng và bảng nào đã được cài). Dùng trước install_object_template. Chỉ quản trị viên (quyền sửa cấu trúc). / ' +
    'Lists ready-made industry templates and which of their tables are already installed. Admins only.',
  permissions: ['custom_objects.manage'],
  input: () => ({}),
  output: (z) => ({ notice: z.string(), data: z.object({ templates: z.array(z.record(z.string(), z.unknown())) }) }),
  async run(_args, { deps }) {
    const out = wrapData({ templates: await deps.templates.list() });
    return { structured: out, text: JSON.stringify(out) };
  },
};
