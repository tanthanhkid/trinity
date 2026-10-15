import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject, type ObjectDef } from '../../../custom-objects/custom-object-access';
import { CUSTOM_ICONS } from '../../../custom-objects/field-types';
import { slugifyKey } from '../../../custom-objects/field-values';
import { MAX_MENU_ENTRIES, type MenuEntry } from '../../../custom-objects/custom-menu.service';
import { assertTypeChosen, unsupportedViewTypeMessage, VIEW_TYPES, type ViewConfig, type ViewSpec, type ViewType } from '../../../custom-objects/view-config';
import type { Z } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef } from './action-types';
import { cleanText, line, lines, renamed, shown } from './action-helpers';
import { makeImpact } from './impact';

/** Lỗi 400/404/409 của service → lời AI sửa được (không coi là lỗi hệ thống). */
export async function asUserError<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BadRequestException || e instanceof ConflictException || e instanceof NotFoundException) {
      const r = e.getResponse() as { message?: string | string[] } | string;
      const m = typeof r === 'string' ? r : Array.isArray(r.message) ? r.message.join('; ') : (r.message ?? e.message);
      throw new ActionUserError(m);
    }
    throw e;
  }
}

export async function loadDefForAction(deps: ActionDeps, user: AuthUser, key: string): Promise<ObjectDef> {
  return asUserError(() => loadVisibleObject(deps.prisma, user, key)).catch((e: unknown) => {
    if (e instanceof ActionUserError) throw new ActionUserError(`Không có bảng “${key}”. Hãy gọi describe_schema để lấy đúng khoá.`);
    throw e;
  });
}

/**
 * Tham số loại màn: enum đúng VIEW_TYPES. Loại lạ / thiếu ⇒ SDK MCP trả lỗi kèm danh sách loại hợp lệ + mô tả
 * (unsupportedViewTypeMessage) để AI hỏi lại người dùng thay vì tự đoán.
 */
export const viewTypeParam = (z: Z) =>
  z.enum(VIEW_TYPES, { error: (iss) => unsupportedViewTypeMessage(iss.input) })
    .describe('Loại màn, một trong: list = danh sách; kanban = cột theo một trường lựa chọn (cần group_by); calendar = lịch tháng/tuần theo trường ngày/giờ (cần date_field); table = bảng sửa nhanh tại ô. ' +
      'Khi người dùng chưa nói loại nào, loại màn do người dùng chọn (mô tả từng loại: list_screen_types). / Screen type: one of list, kanban, calendar, table; if the user has not said which, it is chosen by the user (see list_screen_types).');

/**
 * Lời người dùng gọi tên loại màn. Máy chủ so với `type` (bỏ tên bảng ra khỏi câu trước khi so): không gọi tên loại nào,
 * hoặc gọi tên loại khác ⇒ từ chối kèm 4 loại — loại màn luôn do người dùng chọn, AI không tự chọn.
 */
export const typeWordsParam = (z: Z) =>
  z.string({ error: () => 'Thiếu type_words: loại màn do người dùng chọn trong list, kanban, calendar, table (list_screen_types); type_words là lời họ gọi tên loại đó. / Missing type_words.' })
    .max(200)
    .describe('Chính lời người dùng gọi tên loại màn, chép nguyên văn (vd "kanban", "xem dạng lịch", "danh sách", "bảng sửa nhanh"). ' +
      'Tên bảng không tính là tên loại màn: "quản lý lịch hẹn" với bảng Lịch hẹn chưa nêu loại màn nào. Lời đồng ý chung ("ok", "tạo đi") với một đề xuất cũng không phải lời chọn loại màn — đó là lời của AI, không phải của người dùng. Lời không nêu đúng loại `type` thì không tạo gì và kết quả trả lại 4 loại để người dùng chọn. / ' +
      "The user's own words naming the screen type (e.g. \"kanban\", \"as a calendar\"); the table name and a generic \"ok\" to a proposal do not count. If they do not name `type`, nothing is created and the 4 types are returned for the user to pick.");

/** Bỏ tên bảng / tên màn khỏi lời người dùng trước khi tìm tên loại màn. */
export const tableNames = (o: { key?: string | null; label?: string | null; label_plural?: string | null }, viewLabel?: unknown): string[] =>
  [o.label, o.label_plural, o.key?.replace(/_/g, ' '), typeof viewLabel === 'string' ? viewLabel : null].filter((x): x is string => !!x);

export const failUser = (msg: string): never => { throw new ActionUserError(msg); };

/** zod dùng chung cho một view (tool create_view và gói propose_workspace). */
export const viewShape = (z: Z) => ({
  key: z.string().min(1).max(48).optional().describe('Khoá view (a-z, 0-9, _), bỏ trống = tự sinh từ tên / View key'),
  label: z.string().min(1).max(100).describe('Tên màn, vd "Pipeline khách hàng" / View name'),
  type: viewTypeParam(z),
  type_words: typeWordsParam(z),
  group_by: z.string().max(48).optional().describe('kanban: khoá trường "lựa chọn" (select) chia cột — thường là trường Trạng thái / Group-by select field'),
  card_fields: z.array(z.string().max(48)).max(6).optional().describe('kanban: trường hiện trên thẻ / Card fields'),
  columns: z.array(z.string().max(48)).max(12).optional().describe('list/table: cột hiện theo thứ tự / Columns'),
  date_field: z.string().max(48).optional().describe('calendar: khoá trường ngày (date) hoặc ngày giờ (datetime), vd ngày hẹn / Date field'),
  mode: z.enum(['month', 'week']).optional().describe('calendar: mặc định xem tháng hay tuần / Default calendar mode'),
  sort_field: z.string().max(48).optional().describe('Sắp xếp theo trường / Sort field'),
  sort_dir: z.enum(['asc', 'desc']).optional(),
  icon: z.string().max(48).optional().describe(`Biểu tượng menu, một trong: ${CUSTOM_ICONS.join(', ')}`),
  show_in_nav: z.boolean().optional().describe('Hiện thành mục menu riêng / Show as a menu item'),
});

export function parseView(raw: Record<string, unknown>): ViewSpec {
  const label = cleanText(raw.label, 100);
  if (!label) throw new ActionUserError('View cần có tên (label).');
  const type = String(raw.type ?? '') as ViewType;
  if (!(VIEW_TYPES as readonly string[]).includes(type)) throw new ActionUserError(unsupportedViewTypeMessage(raw.type));
  const key = raw.key ? cleanText(raw.key, 48) : slugifyKey(label);
  const config: Record<string, unknown> = {};
  if (raw.group_by) config.group_by = cleanText(raw.group_by, 48);
  if (Array.isArray(raw.card_fields)) config.card_fields = raw.card_fields.map((x) => cleanText(x, 48));
  if (Array.isArray(raw.columns)) config.columns = raw.columns.map((x) => cleanText(x, 48));
  if (raw.date_field) config.date_field = cleanText(raw.date_field, 48);
  if (raw.mode === 'week' || raw.mode === 'month') config.mode = raw.mode;
  if (raw.sort_field) config.sort = { field: cleanText(raw.sort_field, 48), dir: raw.sort_dir === 'desc' ? 'desc' : 'asc' };
  return { key, label, type, config, icon: raw.icon ? cleanText(raw.icon, 48) : null, show_in_nav: raw.show_in_nav === true };
}

export const describeView = (s: Pick<ViewSpec, 'type' | 'config' | 'show_in_nav'>): string =>
  `${s.type === 'kanban' ? `Kanban theo “${String(s.config.group_by)}”` : s.type === 'calendar' ? `Lịch (${s.config.mode === 'week' ? 'tuần' : 'tháng'}) theo “${String(s.config.date_field)}”` : s.type === 'table' ? 'Bảng sửa nhanh tại ô' : 'Danh sách'}${s.show_in_nav ? ', hiện ở menu' : ''}`;

export const createViewAction: ActionToolDef = {
  name: 'create_view',
  label: 'Tạo màn xem (danh sách/kanban/lịch/bảng)',
  title: 'Tạo màn / giao diện mới cho bảng / Create a screen (view)',
  description:
    'Tạo một màn (giao diện) mới cho một bảng tuỳ biến (khoá bảng từ describe_schema). Trinity có đúng 4 loại màn — type là một trong: ' +
    'list (danh sách: cột, lọc, sắp xếp), kanban (cột theo một trường "lựa chọn" như Trạng thái; cần group_by = khoá trường select), ' +
    'calendar (lịch tháng/tuần; cần date_field = khoá trường date/datetime), table (bảng sửa nhanh tại ô). ' +
    'Ví dụ lời gọi tên loại: "xem đơn dạng lịch" = calendar theo trường ngày; "pipeline", "kéo thả theo trạng thái" = kanban; "danh sách" = list; "bảng sửa nhanh" = table. ' +
    'Loại khác (biểu đồ, dashboard, gantt, bản đồ, 3D…) bị từ chối. Loại màn luôn do người dùng chọn, kể cả khi bảng đã có sẵn: type_words mang lời họ gọi tên loại đó; lời không nêu loại nào (vd "làm chỗ quản lý lịch hẹn") thì máy chủ không tạo và trả 4 loại để hỏi người dùng (list_screen_types mô tả từng loại và trường phù hợp của bảng). ' +
    'show_in_nav=true để thành mục menu riêng (hoặc set_menu). Dành cho quản trị viên; tạo ngay. / ' +
    'Creates a new screen for a custom table. type is one of list, kanban (needs group_by = a select field), calendar (needs date_field = a date/datetime field), table; other types are rejected. ' +
    'The type is picked by the user in every case, existing table included; type_words carries their words for it, and words that name no type (e.g. "a place to manage appointments") create nothing and return the 4 types. Admins only.',
  permissions: ['custom_objects.manage'],
  destructive: false,
  idempotent: false,
  input: (z) => ({ object: z.string().min(1).max(48).describe('Khoá bảng / Table key'), ...viewShape(z) }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const def = await loadDefForAction(deps, user, key);
    const spec = parseView(args);
    assertTypeChosen(spec.type, args.type_words, tableNames(def.obj, args.label), failUser);
    const taken = (await deps.prisma.customView.findMany({ where: { object_id: def.obj.id, deleted_at: null }, select: { key: true } })).map((v) => v.key);
    const ok = await asUserError(() => deps.views.check(def, spec, taken));
    return {
      params: { object: key, view: ok },
      summary: shown(`Tạo màn “${ok.label}” cho bảng “${def.obj.label}”: ${describeView(ok)}`),
      details: lines(line('Bảng', `${def.obj.label} [${key}]`), line('Màn', `${ok.label} [${ok.key}]`), line('Kiểu', describeView(ok)), line('Cấu hình', JSON.stringify(ok.config), 600)),
    };
  },
  async execute(params, { deps, user }) {
    const def = await loadVisibleObject(deps.prisma, user, String(params.object));
    const v = await deps.views.create(def, params.view as ViewSpec, user);
    return { view: v.key, open_at: `/x/${def.obj.key}/v/${v.key}` };
  },
};

export const updateViewAction: ActionToolDef = {
  name: 'update_view',
  label: 'Sửa màn xem',
  title: 'Sửa / ẩn màn xem / Edit a view',
  description:
    'Đổi tên, loại màn (list, kanban, calendar, table — như create_view), trường chia cột, cột hiển thị, sắp xếp, hiện/ẩn menu, hoặc xoá (remove=true) một màn xem. Không động tới dữ liệu bản ghi. ' +
    'Dành cho quản trị viên; chạy ngay. / Changes or removes a view immediately (no record data changes); type is one of list, kanban, calendar, table.',
  permissions: ['custom_objects.manage'],
  destructive: true,
  idempotent: true,
  input: (z) => ({
    object: z.string().min(1).max(48).describe('Khoá bảng / Table key'),
    view: z.string().min(1).max(48).describe('Khoá view (từ describe_schema.views) / View key'),
    ...viewShape(z), label: z.string().min(1).max(100).optional(), type: viewTypeParam(z).optional(),
    type_words: typeWordsParam(z).optional().describe('Khi đổi loại màn (type): chính lời người dùng gọi tên loại mới, như create_view. / When changing type: the user\'s own words naming the new type.'),
    remove: z.boolean().optional().describe('true = xoá màn xem này / Remove the view'),
  }),
  async prepare(args, { deps, user }) {
    const key = cleanText(args.object, 48);
    const viewKey = cleanText(args.view, 48);
    const def = await loadDefForAction(deps, user, key);
    const cur = await deps.prisma.customView.findFirst({ where: { object_id: def.obj.id, key: viewKey, deleted_at: null } });
    if (!cur) throw new ActionUserError(`Bảng “${def.obj.label}” không có view “${viewKey}”.`);
    const c = (cur.config ?? {}) as ViewConfig;
    const merged = parseView({
      key: viewKey, label: args.label ?? cur.label, type: args.type ?? cur.type,
      group_by: args.group_by ?? c.group_by, card_fields: args.card_fields ?? c.card_fields, columns: args.columns ?? c.columns,
      date_field: args.date_field ?? c.date_field, mode: args.mode ?? c.mode,
      sort_field: args.sort_field ?? c.sort?.field, sort_dir: args.sort_dir ?? c.sort?.dir, icon: args.icon ?? cur.icon, show_in_nav: args.show_in_nav ?? cur.show_in_nav,
    });
    if (args.remove !== true && args.type !== undefined && args.type !== cur.type) assertTypeChosen(merged.type, args.type_words, tableNames(def.obj, cur.label), failUser);
    if (args.remove !== true) await asUserError(() => deps.views.check(def, merged, []));
    const patch = args.remove === true ? { is_deleted: true } : { label: merged.label, type: merged.type, config: merged.config, icon: args.icon === undefined ? undefined : merged.icon, show_in_nav: args.show_in_nav as boolean | undefined };
    return {
      params: { object: key, view: viewKey, patch },
      impact: makeImpact([], [args.remove === true ? `Màn “${cur.label}” sẽ bị xoá khỏi menu và danh sách màn; dữ liệu bản ghi không đổi (quay lui được).` : `Đổi cách hiển thị màn “${cur.label}”; dữ liệu bản ghi không đổi.`]),
      summary: shown(args.remove === true ? `XOÁ màn “${cur.label}” của bảng “${def.obj.label}”` : `Sửa màn “${renamed(cur.label, merged.label)}” của bảng “${def.obj.label}”: ${describeView(merged)}`),
      details: lines(line('Bảng', `${def.obj.label} [${key}]`), line('Màn', `${cur.label} [${viewKey}]`), line('Thay đổi', JSON.stringify(patch), 600)),
    };
  },
  async execute(params, { deps, user }) {
    const def = await loadVisibleObject(deps.prisma, user, String(params.object));
    await deps.views.update(def, String(params.view), params.patch as never, user);
    return { view: params.view, open_at: `/x/${def.obj.key}/v/${String(params.view)}` };
  },
};

export const menuShape = (z: Z) => z.array(z.object({
  object: z.string().min(1).max(48).describe('Khoá bảng'),
  view: z.string().min(1).max(48).optional().describe('Khoá view của bảng (bỏ trống = trang danh sách mặc định của bảng)'),
  roles: z.array(z.string().max(100)).max(20).optional().describe('Tên vai trò được thấy mục này (bỏ trống = mọi người có quyền xem dữ liệu). Đặt cho BẢNG là thu hẹp cả quyền thấy bảng.'),
})).min(1).max(MAX_MENU_ENTRIES);

export function parseMenu(raw: unknown): MenuEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ActionUserError('menu cần ít nhất một mục {object, view?}.');
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const e: MenuEntry = { object: cleanText(o.object, 48) };
    if (o.view) e.view = cleanText(o.view, 48);
    if (Array.isArray(o.roles)) e.roles = o.roles.map((x) => cleanText(x, 100)).filter(Boolean);
    return e;
  });
}

export const setMenuAction: ActionToolDef = {
  name: 'set_menu',
  label: 'Đặt menu',
  title: 'Đặt menu (thứ tự, vai trò được thấy) / Set the menu',
  description:
    'Đặt lại menu các bảng tuỳ biến và màn xem: mục liệt kê hiện theo ĐÚNG thứ tự; bảng/màn KHÔNG liệt kê sẽ ẩn khỏi menu (dữ liệu giữ nguyên). ' +
    'Module có sẵn (Khách hàng, Công việc, Lương…) bật/tắt bằng propose_workspace.features. CHỈ quản trị viên; chạy ngay. / Sets the menu order and visibility immediately.',
  permissions: ['custom_objects.manage'],
  destructive: true,
  idempotent: true,
  input: (z) => ({ menu: menuShape(z).describe('Các mục menu theo thứ tự / Menu entries in order') }),
  async prepare(args, { deps }) {
    const entries = parseMenu(args.menu);
    const items = await asUserError(() => deps.menu.resolve(entries));
    const shownNow = await deps.prisma.customObject.findMany({ where: { deleted_at: null, show_in_nav: true }, select: { id: true, label: true } });
    const hidden = shownNow.filter((o) => !items.some((it) => it.objectId === o.id && it.viewId === null)).map((o) => o.label);
    return {
      params: { menu: entries },
      impact: makeImpact([], [hidden.length ? `Bỏ khỏi menu: ${hidden.join(', ')} (dữ liệu giữ nguyên, vẫn mở được qua đường dẫn).` : 'Chỉ đổi thứ tự/vai trò thấy menu.']),
      summary: shown(`Đặt menu ${items.length} mục: ${items.map((i) => i.label).join(' · ')}`),
      details: lines(...items.map((it, i) => line(`Mục ${i + 1}`, `${it.label}${it.rolesGiven ? ` — vai trò: ${(entries[i].roles ?? []).join(', ') || '(mọi người)'}` : ''}`))),
    };
  },
  async execute(params, { deps, user }) {
    return deps.menu.apply(params.menu as MenuEntry[], user);
  },
};
