import type { AuthUser } from '@trinity/rbac-nest';
import { BASIC_FEATURES, ORG_FEATURES, type OrgFeatureKey } from '@trinity/rbac';
import { loadVisibleObject } from '../../../custom-objects/custom-object-access';
import { MAX_MENU_ENTRIES, type MenuEntry } from '../../../custom-objects/custom-menu.service';
import { CUSTOM_ICONS } from '../../../custom-objects/field-types';
import type { Z } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef, type DetailLine } from './action-types';
import { cleanText, line, lines, shown } from './action-helpers';
import { applyObjects, checkObjects, fieldShape, parseObject } from './structure-spec';
import { asUserError, describeView, failUser, menuShape, parseMenu, parseView, tableNames, viewShape } from './action-view-tools';
import { assertTypeChosen } from '../../../custom-objects/view-config';
import { assertConfirmed, confirmationParam, CONSENT_NOTE } from './user-confirmation';
import { defaultMenu, MAX_PACKAGE_VIEWS, parseFeatures, pseudoDef, type PackageView, type WorkspacePackage } from './workspace-spec';

const MAX_OBJECTS = 8;

const input = (z: Z) => ({
  title: z.string().min(1).max(150).describe('Tên gói, vd "CRM cửa hàng bán lẻ" / Package title'),
  objects: z.array(z.object({
    key: z.string().min(1).max(48).optional(), label: z.string().min(1).max(100), label_plural: z.string().min(1).max(100).optional(),
    icon: z.string().max(48).optional().describe(`Một trong: ${CUSTOM_ICONS.join(', ')}`), description: z.string().max(500).optional(),
    code_prefix: z.string().min(2).max(4).optional().describe('Tiền tố mã bản ghi 2–4 chữ in hoa (vd SP → SP001); bỏ trống = tự sinh'),
    fields: z.array(z.object(fieldShape(z))).max(60).optional(),
  })).min(1).max(MAX_OBJECTS).describe('Bảng + trường. Trạng thái/bước quy trình = trường select có choices theo đúng thứ tự các bước / Tables with fields'),
  views: z.array(z.object({ object: z.string().min(1).max(48).describe('Khoá bảng (trong gói hoặc có sẵn)'), ...viewShape(z) })).max(MAX_PACKAGE_VIEWS).optional()
    .describe('Màn xem; type là một trong list, kanban, calendar, table (list_screen_types): kanban group_by = trường trạng thái (select); calendar date_field = trường ngày/giờ (vd ngày hẹn); table = sửa nhanh tại ô; loại khác bị từ chối / Views: type is one of list, kanban, calendar, table'),
  menu: menuShape(z).optional().describe(`Menu theo thứ tự (≤${MAX_MENU_ENTRIES}); bỏ trống = mỗi bảng một mục, ưu tiên kanban / Menu`),
  confirmed_by_user: confirmationParam(z),
  features: z.array(z.string().max(32)).max(20).optional()
    .describe(`Module có sẵn cần BẬT thêm ngoài bộ cơ bản (${BASIC_FEATURES.join(', ')}); hệ thống mới thì các module khác tắt: ${Object.entries(ORG_FEATURES).map(([k, v]) => `${k}=${v.label}`).join('; ')} / Built-in modules to enable`),
});

function parsePackage(args: Record<string, unknown>): WorkspacePackage {
  const title = cleanText(args.title, 150);
  if (!title) throw new ActionUserError('Cần title cho gói dựng.');
  const rawObjects = Array.isArray(args.objects) ? args.objects : [];
  if (rawObjects.length === 0 || rawObjects.length > MAX_OBJECTS) throw new ActionUserError(`Gói cần 1–${MAX_OBJECTS} bảng.`);
  const objects = rawObjects.map(parseObject);
  const views: PackageView[] = (Array.isArray(args.views) ? args.views : []).map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return { ...parseView(o), object: cleanText(o.object, 48), type_words: typeof o.type_words === 'string' ? o.type_words.slice(0, 200) : undefined };
  });
  const menu = args.menu === undefined || args.menu === null ? null : parseMenu(args.menu);
  return { title, objects, views, menu, features: parseFeatures(args.features) };
}

/**
 * Vai trò trong menu phải CÓ THẬT ngay lúc đề xuất (vai trò không có ⇒ gói chỉ hỏng lúc duyệt). Báo AI danh
 * sách vai trò hiện có để hỏi lại khách — Trinity không tự tạo vai trò qua AI.
 */
export async function checkRoles(deps: ActionDeps, menu: MenuEntry[]): Promise<void> {
  const wanted = [...new Set(menu.flatMap((m) => m.roles ?? []).map((r) => String(r).trim()).filter(Boolean))];
  if (wanted.length === 0) return;
  const roles = await deps.prisma.role.findMany({ select: { name: true }, orderBy: { id: 'asc' }, take: 100 });
  const have = new Set(roles.map((r) => r.name.trim().toLowerCase()));
  const missing = wanted.filter((r) => !have.has(r.toLowerCase()));
  if (missing.length) {
    throw new ActionUserError(`Menu: không có vai trò ${missing.map((r) => `“${r.slice(0, 60)}”`).join(', ')}. Vai trò hiện có: ${roles.map((r) => r.name).join(', ') || '(chưa có)'}. ` +
      'Hãy dùng đúng tên vai trò có sẵn, bỏ trống roles (mọi người thấy), hoặc nhờ quản trị viên tạo vai trò ở Cài đặt › Vai trò rồi đề xuất lại.');
  }
}

/** Kiểm cả gói KHÔNG ghi: bảng (khoá trống, trường hợp lệ), view (bảng tồn tại, trường chia cột đúng kiểu), menu trỏ đúng chỗ. */
async function checkPackage(deps: ActionDeps, user: AuthUser, p: WorkspacePackage): Promise<void> {
  await checkObjects(deps, p.objects);
  const seen = new Map<string, string[]>();
  for (const v of p.views) {
    const spec = p.objects.find((o) => o.key === v.object);
    const def = spec ? pseudoDef(spec) : await loadVisibleObject(deps.prisma, user, v.object).catch(() => {
      throw new ActionUserError(`View “${v.label}”: không có bảng “${v.object}” (trong gói hoặc có sẵn).`);
    });
    const taken = seen.get(v.object) ?? (spec ? [] : (await deps.prisma.customView.findMany({ where: { object_id: def.obj.id, deleted_at: null }, select: { key: true } })).map((x) => x.key));
    assertTypeChosen(v.type, v.type_words, tableNames(spec ?? def.obj, v.label), failUser);
    const ok = await asUserError(() => deps.views.check(def, v, taken));
    Object.assign(v, { config: ok.config });
    seen.set(v.object, [...taken, v.key]);
  }
  const menu = p.menu ?? defaultMenu(p.objects, p.views);
  await checkRoles(deps, menu);
  const live = await deps.prisma.customObject.findMany({ where: { deleted_at: null }, select: { key: true } });
  const known = new Set([...live.map((o) => o.key), ...p.objects.map((o) => o.key)]);
  for (const m of menu) {
    if (!known.has(m.object)) throw new ActionUserError(`Menu: không có bảng “${m.object}”.`);
    if (m.view && !p.views.some((v) => v.object === m.object && v.key === m.view)) {
      const exists = await deps.prisma.customView.count({ where: { key: m.view, deleted_at: null, object: { key: m.object, deleted_at: null } } });
      if (!exists) throw new ActionUserError(`Menu: bảng “${m.object}” không có view “${m.view}”.`);
    }
  }
}

function describe(p: WorkspacePackage, blank: boolean): DetailLine[] {
  const menu = p.menu ?? defaultMenu(p.objects, p.views);
  const on = p.features.map((k) => ORG_FEATURES[k].label);
  return lines(
    ...p.objects.map((o) => line(`Bảng ${o.label}${o.code_prefix ? ` (mã ${o.code_prefix}001…)` : ''}`, o.fields.map((f) => `${f.label} (${f.type}${f.choices ? `: ${f.choices.map((c) => (typeof c === 'string' ? c : c.label)).join(' → ')}` : ''}${f.target_object ? ` → ${f.target_object}` : ''})`).join('; ') || '(chưa có trường)', 900)),
    line('Màn xem', p.views.map((v) => `${v.label} (${describeView({ ...v, show_in_nav: false })})`).join('; ') || '(chỉ danh sách mặc định)'),
    line('Menu', menu.map((m) => (m.view ? `${m.object}/${m.view}` : m.object)).join(' · ')),
    line(blank ? 'Module bật (còn lại TẮT)' : 'Module bật thêm', on.length ? on.join(', ') : '(không)'),
  );
}

/** Ảnh chụp menu (show_in_nav, nav_order) để trả lại nếu dựng lỗi giữa chừng. */
async function snapshotNav(deps: ActionDeps) {
  const [objects, views] = await Promise.all([
    deps.prisma.customObject.findMany({ where: { deleted_at: null }, select: { id: true, show_in_nav: true, nav_order: true } }),
    deps.prisma.customView.findMany({ where: { deleted_at: null }, select: { id: true, show_in_nav: true, nav_order: true } }),
  ]);
  return async () => {
    for (const o of objects) await deps.prisma.customObject.update({ where: { id: o.id }, data: { show_in_nav: o.show_in_nav, nav_order: o.nav_order } }).catch(() => undefined);
    for (const v of views) await deps.prisma.customView.update({ where: { id: v.id }, data: { show_in_nav: v.show_in_nav, nav_order: v.nav_order } }).catch(() => undefined);
  };
}

async function applyFeatures(deps: ActionDeps, user: AuthUser, keys: OrgFeatureKey[], blank: boolean): Promise<void> {
  if (blank) {
    // Hệ thống mới: bộ cơ bản luôn bật, cộng các module AI chọn theo ngành.
    await deps.orgFeatures.replaceAll([...new Set<OrgFeatureKey>([...BASIC_FEATURES, ...keys])], user.userId);
    return;
  }
  if (keys.length) await deps.orgFeatures.update(Object.fromEntries(keys.map((k) => [k, true])) as never, user.userId);
}

/**
 * DUYỆT gói: bảng → trường → view → menu → tính năng → trạng thái `dang_dung`. Lỗi bất kỳ bước nào ⇒ XOÁ HẲN các bảng vừa tạo
 * (kèm trường/view, chưa có bản ghi), trả menu + tính năng + trạng thái về như trước: không bao giờ để hệ thống dựng nửa vời.
 */
async function executePackage(deps: ActionDeps, user: AuthUser, p: WorkspacePackage): Promise<Record<string, unknown>> {
  const status = await deps.setup.get();
  const blank = status === 'chua_dung';
  const featuresBefore = await deps.orgFeatures.stored();
  const restoreNav = await snapshotNav(deps);
  const startedAt = new Date();
  let created: string[] = [];
  try {
    created = await applyObjects(deps, user, p.objects);
    for (const v of p.views) await deps.views.create(await loadVisibleObject(deps.prisma, user, v.object), v, user);
    await deps.menu.apply(p.menu ?? defaultMenu(p.objects, p.views), user);
    await applyFeatures(deps, user, p.features, blank);
    if (status !== 'da_dung') await deps.setup.set('dang_dung', user.userId);
  } catch (e) {
    // Xoá HẲN mọi bảng của gói vừa tạo trong lượt này (kể cả bảng applyObjects đã tự xoá mềm) — cascade trường + view.
    await deps.prisma.customObject.deleteMany({ where: { key: { in: p.objects.map((o) => o.key) }, created_by: user.userId, created_at: { gte: startedAt } } }).catch(() => undefined);
    await restoreNav();
    if (featuresBefore === undefined) await deps.prisma.setting.deleteMany({ where: { key: 'org_features' } }).catch(() => undefined);
    else await deps.prisma.setting.update({ where: { key: 'org_features' }, data: { value: JSON.stringify(featuresBefore) } }).catch(() => undefined);
    await deps.setup.set(status, user.userId).catch(() => undefined);
    throw e;
  }
  const first = (p.menu ?? defaultMenu(p.objects, p.views))[0];
  return { created_objects: created, views: p.views.map((v) => `${v.object}/${v.key}`), setup_status: status === 'da_dung' ? 'da_dung' : 'dang_dung', open_at: first ? (first.view ? `/x/${first.object}/v/${first.view}` : `/x/${first.object}`) : '/bat-dau' };
}

export const proposeWorkspaceAction: ActionToolDef = {
  name: 'propose_workspace',
  label: 'Dựng quy trình (cả gói)',
  title: 'Dựng cả CRM trong MỘT gói: bảng + trường + trạng thái + kanban + menu + module / Build a whole workspace',
  description:
    'Sau khi phỏng vấn (get_setup_guide), dựng MỘT gói toàn bộ CRM trong MỘT lần: bảng + trường (trạng thái/bước quy trình = trường select có choices đúng thứ tự), ' +
    'màn kanban/lịch/bảng/danh sách, menu và các module có sẵn cần bật (hệ thống mới: bộ cơ bản luôn bật, module khác tắt). Chạy ngay; lỗi giữa chừng thì không dựng gì (không nửa vời). ' +
    'Có thể lấy cảm hứng từ list_object_templates. Bảng lõi contacts (khách hàng) thuộc bộ cơ bản, dùng được làm đích liên kết. ' +
    'Cấu trúc (bảng, cột, màn) do người dùng duyệt trước khi dựng: confirmed_by_user là ' + CONSENT_NOTE + '; thiếu lời đồng ý thì máy chủ không dựng gì và trả bản dự kiến để người dùng xem. Màn trong views cần type_words như create_view. ' +
    'Dành cho quản trị viên. Sau đó: nhập dữ liệu bằng import_records rồi complete_setup. / Builds the whole workspace in one run once the user has confirmed the planned structure (confirmed_by_user). Admins only.',
  permissions: ['custom_objects.manage', 'settings.features'],
  destructive: false,
  idempotent: false,
  input,
  async prepare(args, { deps, user }) {
    const p = parsePackage(args);
    await checkPackage(deps, user, p);
    const blank = (await deps.setup.get()) === 'chua_dung';
    assertConfirmed(args.confirmed_by_user, describe(p, blank));
    return {
      params: p as unknown as Record<string, unknown>,
      summary: shown(`Dựng gói “${p.title}”: ${p.objects.length} bảng (${p.objects.map((o) => o.label).join(', ')}), ${p.views.length} màn xem${p.features.length ? `, bật ${p.features.length} module` : ''}`),
      details: describe(p, blank),
    };
  },
  execute: (params, { deps, user }) => executePackage(deps, user, params as unknown as WorkspacePackage),
};
