import { assertConfirmed, confirmationParam, CONSENT_NOTE } from './user-confirmation';
import { CUSTOM_OBJECT_TEMPLATES, findTemplate } from '../../../custom-objects/templates';
import { ActionUserError, type ActionToolDef } from './action-types';
import { cleanText, line, lines, shown } from './action-helpers';
import { requirePerm } from '../tools/core-records';
import { INDUSTRY_KEYS, INDUSTRY_PRESETS, MAX_BUILD_FEATURES, ORG_FEATURES, ORG_FEATURE_KEYS, isIndustryKey } from '@trinity/rbac';
import { isUserConfirmation } from './user-confirmation';

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

/**
 * Dựng hệ thống theo loại doanh nghiệp (cùng service với wizard). Đi qua đường đề xuất/duyệt như các tool ghi khác; tạo bảng mới
 * hoặc tắt phân hệ đang bật cần lời đồng ý của người dùng (confirmed_by_user).
 */
export const setupBuildAction: ActionToolDef = {
  name: 'setup_build',
  label: 'Dựng hệ thống theo loại doanh nghiệp',
  title: 'Dựng hệ thống theo loại doanh nghiệp / Build workspace from an industry preset',
  description:
    'Dựng CRM trong MỘT lần: chọn loại doanh nghiệp (industry) và phân hệ muốn dùng (features). Trinity áp mẫu ngành (bảng + trường + liên kết), lưu phân hệ, kèm vài bản ghi MẪU giả (tự xoá khi có bản ghi thật đầu tiên) và đặt trạng thái đã dựng. ' +
    `industry: ${INDUSTRY_KEYS.map((k) => `${k}=${INDUSTRY_PRESETS[k].label}`).join('; ')}. ` +
    `features (tuỳ chọn; bộ cơ bản dashboard, contacts, kanban, reports luôn bật): ${ORG_FEATURE_KEYS.map((k) => `${k}=${ORG_FEATURES[k].label}`).join('; ')}. ` +
    'Chạy lại được: bảng đã có thì giữ nguyên; chạy lại KHÔNG truyền features thì giữ các phân hệ đang bật (không tắt gì), có truyền features thì thay đúng theo danh sách đó. ' +
    'Khi sẽ TẠO BẢNG MỚI hoặc TẮT phân hệ đang bật, confirmed_by_user là ' + CONSENT_NOTE + '; thiếu thì máy chủ không làm gì và trả danh sách để người dùng xem. Muốn bảng riêng theo lời khách thì dùng propose_workspace. Chỉ quản trị viên. / Builds the workspace from an industry preset; creating tables or turning modules off needs confirmed_by_user. Admins only.',
  permissions: ['custom_objects.manage', 'settings.features'],
  destructive: false,
  idempotent: true,
  input: (z) => ({
    industry: z.enum(INDUSTRY_KEYS as unknown as [string, ...string[]]).describe('Loại doanh nghiệp / Industry preset'),
    features: z.array(z.string().max(32)).max(MAX_BUILD_FEATURES).optional().describe('Khoá phân hệ muốn dùng; bỏ trống = bộ gợi ý của ngành (lần đầu) hoặc giữ nguyên (dựng lại) / Module keys'),
    confirmed_by_user: confirmationParam(z).optional(),
  }),
  async prepare(args, { deps, user }) {
    if (!deps.setupBuild) throw new ActionUserError('Máy chủ này chưa bật tính năng dựng theo loại doanh nghiệp.');
    if (!isIndustryKey(args.industry)) throw new ActionUserError(`Loại doanh nghiệp không hợp lệ. Chọn một trong: ${INDUSTRY_KEYS.join(', ')}.`);
    const industry = args.industry;
    const preset = INDUSTRY_PRESETS[industry];
    const chosen = Array.isArray(args.features) ? args.features.map(String) : undefined;
    const plan = await deps.setupBuild.plan(industry, chosen);
    const t = preset.template ? findTemplate(preset.template) : undefined;
    const live = new Set((await deps.prisma.customObject.findMany({ where: { deleted_at: null }, select: { key: true } })).map((o) => o.key));
    const fresh = (t?.objects ?? []).filter((o) => !live.has(o.key));
    const now = await deps.orgFeatures.get();
    const off = ORG_FEATURE_KEYS.filter((k) => now[k] && !plan.features.includes(k));
    const preview = lines(
      ...fresh.map((o) => line(`Bảng ${o.label_plural}`, (o.fields ?? []).map((f) => `${f.label} (${f.type})`).join('; ') || '(chưa có trường)', 900)),
      ...(off.length ? [line('Phân hệ sẽ TẮT', off.map((k) => ORG_FEATURES[k].label).join(', '))] : []),
    );
    if ((fresh.length || off.length) && !isUserConfirmation(args.confirmed_by_user)) assertConfirmed(args.confirmed_by_user, preview);
    return {
      // `resolved` = danh sách phân hệ ĐÃ GIẢI lúc đề xuất (người dùng duyệt đúng danh sách này); lúc chạy so lại, khác thì không làm.
      params: { industry, features: chosen ?? null, resolved: plan.features },
      summary: shown(`Dựng hệ thống “${preset.label}”: ${fresh.length} bảng mới, ${plan.features.length} phân hệ bật${off.length ? `, tắt ${off.length}` : ''}`),
      details: lines(line('Loại doanh nghiệp', preset.label), line('Bảng sẽ tạo', fresh.map((o) => o.label_plural).join(', ') || '(không)'), line('Phân hệ bật', plan.features.map((k) => ORG_FEATURES[k].label).join(', ')), line('Dữ liệu mẫu', 'Vài dòng giả, tự xoá khi có dữ liệu thật')),
    };
  },
  async execute(params, { deps, user }) {
    const industry = String(params.industry);
    const chosen = Array.isArray(params.features) ? (params.features as string[]) : undefined;
    const resolved = Array.isArray(params.resolved) ? (params.resolved as string[]) : null;
    if (resolved && isIndustryKey(industry)) {
      const now = (await deps.setupBuild!.plan(industry, chosen)).features as string[];
      if (now.length !== resolved.length || now.some((k, i) => k !== resolved[i])) {
        throw new ActionUserError('Danh sách phân hệ đã đổi kể từ lúc đề xuất (có người bật/tắt phân hệ khác). Chưa dựng gì: hãy đề xuất lại để xem danh sách mới.');
      }
    }
    const r = await deps.setupBuild!.build(user, { industry, features: resolved ?? chosen });
    return { industry: r.industry, created_objects: r.created_objects, kept_objects: r.existing_objects, sample_records: r.sample_records + r.sample_contacts };
  },
};
