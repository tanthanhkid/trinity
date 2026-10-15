import { assertConfirmed, confirmationParam, CONSENT_NOTE } from './user-confirmation';
import { CUSTOM_OBJECT_TEMPLATES, findTemplate } from '../../../custom-objects/templates';
import { ActionUserError, type ActionToolDef } from './action-types';
import { cleanText, line, lines, shown } from './action-helpers';
import { requirePerm } from '../tools/core-records';

export const installTemplateAction: ActionToolDef = {
  name: 'install_object_template',
  label: 'Cài mẫu bảng theo ngành',
  title: 'Cài mẫu bảng theo ngành / Install an industry template',
  description:
    'Cài một MẪU NGÀNH dựng sẵn (bảng + trường + liên kết). Gọi list_object_templates để biết khoá mẫu. Bảng đã có thì giữ nguyên. with_sample_data=true tạo thêm dữ liệu mẫu GIẢ (cần thêm quyền ghi dữ liệu tuỳ biến). ' +
    'Bảng + cột của mẫu do người dùng duyệt trước khi cài: confirmed_by_user là ' + CONSENT_NOTE + '; thiếu lời đồng ý thì máy chủ không cài gì và trả danh sách bảng + cột của mẫu để người dùng xem. Dành cho quản trị viên. / Installs a ready-made industry template once the user has confirmed its tables and columns (confirmed_by_user). Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: false,
  idempotent: true,
  input: (z) => ({
    template: z.string().min(1).max(64).describe('Khoá mẫu (từ list_object_templates) / Template key'),
    with_sample_data: z.boolean().optional().describe('Tạo kèm dữ liệu mẫu giả / Include fake sample data'),
    confirmed_by_user: confirmationParam(z),
  }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.template, 64);
    const t = findTemplate(key);
    if (!t) throw new ActionUserError(`Không có mẫu “${key}”. Mẫu hiện có: ${CUSTOM_OBJECT_TEMPLATES.map((x) => x.key).join(', ')}.`);
    const sample = args.with_sample_data === true;
    if (sample) requirePerm(user, 'custom_records.manage');
    const live = new Set((await deps.prisma.customObject.findMany({ where: { deleted_at: null }, select: { key: true } })).map((o) => o.key));
    const fresh = t.objects.filter((o) => !live.has(o.key));
    if (fresh.length) assertConfirmed(args.confirmed_by_user, lines(...fresh.map((o) => line(`Bảng ${o.label_plural}`, (o.fields ?? []).map((f) => `${f.label} (${f.type})`).join('; ') || '(chưa có trường)', 900))));
    return {
      params: { template: key, with_sample_data: sample },
      summary: shown(`Cài mẫu “${t.label}”: tạo ${fresh.length} bảng${fresh.length < t.objects.length ? `, giữ ${t.objects.length - fresh.length} bảng đã có` : ''}${sample ? ', kèm dữ liệu mẫu giả' : ''}`),
      details: lines(line('Mẫu', t.label), line('Bảng sẽ tạo', fresh.map((o) => o.label_plural).join(', ') || '(không — đã có đủ)'), line('Dữ liệu mẫu', sample ? 'Có (giả)' : 'Không')),
    };
  },
  async execute(params, { deps, user }) {
    const r = await deps.templates.apply(user, String(params.template), params.with_sample_data === true);
    return { created: r.created, existing: r.existing, sample_records: r.sample_records };
  },
};
