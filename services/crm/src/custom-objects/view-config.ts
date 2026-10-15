import { BadRequestException } from '@nestjs/common';
import type { ObjectDef } from './custom-object-access';
import { CUSTOM_ICONS, DATE_TYPES, KEY_REGEX, SORTABLE_TYPES } from './field-types';
import { buildFilters } from './record-query';

/** Kiểu màn xem: danh sách, kanban, lịch (theo trường ngày/giờ) và bảng sửa nhanh tại ô. */
export const VIEW_TYPES = ['list', 'kanban', 'calendar', 'table'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
export const MAX_VIEWS_PER_OBJECT = 10;

/** Một loại màn xem mà web Trinity render được (apps/web: /x/<bảng>/v/<màn>) — danh mục này là nguồn duy nhất cho MCP và thông báo lỗi. */
export interface ViewTypeInfo {
  type: ViewType;
  /** Tên tiếng Việt hiện cho người dùng. */
  name: string;
  /** Màn trông thế nào / làm được gì (VI / EN). */
  summary: string;
  /** Trường cấu hình bắt buộc (khoá tham số → kiểu trường của bảng phải có). Rỗng = không bắt buộc gì. */
  requires: Record<string, string>;
  /** Tham số tuỳ chọn. */
  optional: string[];
  /** Hợp với việc gì. */
  good_for: string;
}

export const VIEW_TYPE_INFO: readonly ViewTypeInfo[] = [
  {
    type: 'list', name: 'Danh sách',
    summary: 'Danh sách bản ghi có cột, tìm kiếm, lọc, sắp xếp; bấm một dòng để mở chi tiết / Record list with columns, search, filters and sorting',
    requires: {}, optional: ['columns (≤12 khoá trường)', 'sort_field', 'sort_dir'],
    good_for: 'Tra cứu, xem tất cả bản ghi / Browsing all records',
  },
  {
    type: 'kanban', name: 'Kanban',
    summary: 'Mỗi cột là một giá trị của một trường lựa chọn (select, vd Trạng thái, Giai đoạn); kéo thẻ sang cột khác để đổi giá trị. Chỉ chia cột theo trường select — trường người dùng, chữ, số, ngày không chia cột được / One column per choice of a select field (only select fields); drag cards to change it',
    requires: { group_by: 'khoá một trường kiểu select (lựa chọn) của bảng / key of a select field' }, optional: ['card_fields (≤6)', 'sort_field', 'sort_dir'],
    good_for: 'Quy trình theo bước: pipeline bán hàng, xử lý đơn, tuyển dụng / Step-by-step pipelines',
  },
  {
    type: 'calendar', name: 'Lịch',
    summary: 'Lịch tháng hoặc tuần; mỗi bản ghi nằm ở ngày của một trường ngày / ngày giờ / Month or week calendar placing records on a date field',
    requires: { date_field: 'khoá một trường kiểu date hoặc datetime của bảng / key of a date or datetime field' }, optional: ['mode (month | week)', 'card_fields (≤6)'],
    good_for: 'Lịch hẹn, lịch giao hàng, hạn chót / Appointments, deliveries, deadlines',
  },
  {
    type: 'table', name: 'Bảng sửa nhanh',
    summary: 'Bảng tính: sửa giá trị ngay tại ô, không mở form / Spreadsheet-style grid with in-cell editing',
    requires: {}, optional: ['columns (≤12 khoá trường)', 'sort_field', 'sort_dir'],
    good_for: 'Nhập / sửa hàng loạt nhanh / Fast bulk editing',
  },
];

/** Một dòng / loại: `kanban (Kanban — …; cần group_by = …)`. Dùng trong mô tả tool và lỗi. */
export const viewTypesLine = (): string =>
  VIEW_TYPE_INFO.map((i) => {
    const req = Object.entries(i.requires).map(([k, v]) => `${k} = ${v.split(' / ')[0]}`).join(', ');
    return `${i.type} (${i.name}: ${i.summary.split(' / ')[0]}${req ? `; cần ${req}` : ''})`;
  }).join('; ');

/** Lời từ chối loại màn không có: nêu đủ các loại hợp lệ + mô tả để người dùng chọn lại. */
export const unsupportedViewTypeMessage = (type: unknown): string => {
  const given = type === undefined || type === null || type === '' ? null : String(type).slice(0, 40);
  return `${given ? `Loại màn “${given}” chưa được Trinity hỗ trợ.` : 'Thiếu loại màn (type).'} Các loại màn Trinity hiển thị được: ${viewTypesLine()}. ` +
    'Loại màn do người dùng chọn trong các loại trên. / ' +
    `${given ? `Screen type "${given}" is not supported.` : 'Missing screen type (type).'} Supported types: ${VIEW_TYPES.join(', ')} (details: list_screen_types).`;
};

/** Bỏ dấu tiếng Việt + chữ thường + gộp khoảng trắng — để so lời người dùng với từ khoá loại màn. */
export const foldVi = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Cụm từ (đã bỏ dấu) cho thấy người dùng đã gọi tên loại màn. "lịch" chỉ tính khi không nằm trong tên bảng
 * (bảng "Lịch hẹn": "quản lý lịch hẹn" chưa phải là chọn màn lịch; "xem dạng lịch" thì đúng).
 */
export const VIEW_TYPE_WORDS: Readonly<Record<ViewType, readonly string[]>> = {
  list: ['danh sach', 'list', 'liet ke', 'tung dong'],
  kanban: ['kanban', 'pipeline', 'keo tha', 'keo the', 'chia cot', 'theo cot', 'dang cot', 'theo trang thai', 'theo giai doan', 'theo buoc', 'board', 'trello'],
  calendar: ['lich', 'calendar', 'theo ngay', 'theo thang', 'theo tuan'],
  table: ['bang sua nhanh', 'sua nhanh', 'bang tinh', 'sua tai o', 'sua tren o', 'kieu bang', 'dang bang', 'bang excel', 'excel', 'table', 'spreadsheet', 'sheet'],
};

/** Các loại màn mà lời người dùng (`words`) gọi tên, sau khi bỏ tên bảng/tên màn (`ignore`) khỏi câu. */
export function viewTypesInWords(words: unknown, ignore: readonly (string | null | undefined)[] = []): ViewType[] {
  let w = ` ${foldVi(typeof words === 'string' ? words : '')} `;
  for (const raw of ignore) {
    const n = raw ? foldVi(raw) : '';
    if (n) w = w.split(` ${n} `).join(' ');
  }
  return VIEW_TYPES.filter((t) => VIEW_TYPE_WORDS[t].some((k) => w.includes(` ${k} `)));
}

/** Lời từ chối khi `type_words` không cho thấy người dùng đã chọn loại màn `type`: nêu đủ 4 loại để hỏi lại người dùng. */
export const typeNotChosenMessage = (type: string, words: unknown): string => {
  const said = typeof words === 'string' && words.trim() ? `“${words.trim().slice(0, 80)}”` : '(trống)';
  return `Chưa tạo màn: lời người dùng ${said} không nêu loại màn “${type}”. Loại màn do người dùng chọn; 4 loại Trinity có: ${viewTypesLine()}. ` +
    'type_words là chính lời người dùng gọi tên loại màn (vd "kanban", "dạng lịch", "danh sách", "bảng sửa nhanh"). / ' +
    `Screen not created: the user's words ${said} do not name the "${type}" type. The user picks one of: ${VIEW_TYPES.join(', ')}; type_words carries the user's own words for it.`;
};

/** Ném lỗi (qua `fail`) nếu lời người dùng không gọi tên đúng loại màn. */
export function assertTypeChosen(type: string, words: unknown, ignore: readonly (string | null | undefined)[], fail: (msg: string) => never): void {
  if (!viewTypesInWords(words, ignore).includes(type as ViewType)) fail(typeNotChosenMessage(type, words));
}
export const MAX_CARD_FIELDS = 6;
export const MAX_COLUMNS = 12;

export interface ViewConfig {
  /** kanban: khoá trường `select` chia cột. */
  group_by?: string;
  /** kanban: trường hiện trên thẻ (ngoài tiêu đề). */
  card_fields?: string[];
  /** list / table: cột hiện (theo thứ tự). */
  columns?: string[];
  /** calendar: khoá trường ngày (`date`) hoặc ngày giờ (`datetime`) để đặt bản ghi lên lịch. */
  date_field?: string;
  /** calendar: xem mặc định theo tháng hay tuần. */
  mode?: 'month' | 'week';
  sort?: { field: string; dir: 'asc' | 'desc' };
  /** Bộ lọc cố định, cùng dạng `filter` của danh sách bản ghi. */
  filter?: Record<string, unknown>;
}

export interface ViewSpec {
  key: string;
  label: string;
  type: ViewType;
  config: ViewConfig;
  icon?: string | null;
  show_in_nav?: boolean;
}

const bad = (m: string): never => {
  throw new BadRequestException(m);
};
const own = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function fieldKeys(def: ObjectDef, raw: unknown, max: number, what: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return bad(`${what} phải là danh sách khoá trường`);
  const keys = [...new Set(raw.map((x) => String(x)))];
  if (keys.length > max) bad(`${what}: tối đa ${max} trường`);
  for (const k of keys) if (!def.fields.some((f) => f.key === k)) bad(`${what}: không có trường “${k.slice(0, 40)}” trong bảng “${def.obj.label}”`);
  return keys;
}

/** Kiểm + chuẩn hoá cấu hình theo định nghĩa bảng THẬT (trường có tồn tại, đúng kiểu). Ném 400 với lời tiếng Việt. */
export function normalizeViewConfig(def: ObjectDef, type: ViewType, raw: unknown): ViewConfig {
  const c = own(raw);
  const out: ViewConfig = {};
  if (type === 'kanban') {
    const g = typeof c.group_by === 'string' ? c.group_by : '';
    const f = def.fields.find((x) => x.key === g);
    if (!g) bad(`Kanban cần group_by là khoá một trường “lựa chọn” (select) của bảng “${def.obj.label}”.`);
    if (!f) bad(`group_by: cột không tồn tại: “${g.slice(0, 40)}” (bảng “${def.obj.label}”). Gọi describe_schema để lấy khoá trường.`);
    if (f && f.type !== 'select') bad(`Trường “${f.label}” kiểu ${f.type} — kanban chỉ chia cột theo trường “lựa chọn” (select).`);
    out.group_by = g;
    out.card_fields = fieldKeys(def, c.card_fields, MAX_CARD_FIELDS, 'card_fields');
  } else if (type === 'calendar') {
    const k = typeof c.date_field === 'string' ? c.date_field : '';
    const f = def.fields.find((x) => x.key === k);
    if (!k) bad(`Lịch cần date_field là khoá một trường ngày (date) hoặc ngày giờ (datetime) của bảng “${def.obj.label}”.`);
    if (!f) bad(`date_field: cột không tồn tại: “${k.slice(0, 40)}” (bảng “${def.obj.label}”). Gọi describe_schema để lấy khoá trường.`);
    if (f && !DATE_TYPES.includes(f.type)) bad(`Trường “${f.label}” kiểu ${f.type} — lịch chỉ dùng trường ngày (date) hoặc ngày giờ (datetime).`);
    out.date_field = k;
    out.mode = c.mode === 'week' ? 'week' : 'month';
    out.card_fields = fieldKeys(def, c.card_fields, MAX_CARD_FIELDS, 'card_fields');
  } else {
    out.columns = fieldKeys(def, c.columns, MAX_COLUMNS, 'columns');
  }
  if (c.sort !== undefined && c.sort !== null) {
    const s = own(c.sort);
    const f = def.fields.find((x) => x.key === s.field);
    if (!f || !SORTABLE_TYPES.includes(f.type)) bad('sort.field phải là trường sắp xếp được (văn bản/số/tiền/ngày…)');
    out.sort = { field: String(s.field), dir: s.dir === 'desc' ? 'desc' : 'asc' };
  }
  if (c.filter !== undefined && c.filter !== null) {
    const filter = own(c.filter);
    buildFilters(def, JSON.stringify(filter));
    out.filter = filter;
  }
  return out;
}

export function assertViewMeta(key: string, label: string, type: string, icon?: string | null): void {
  if (!KEY_REGEX.test(key)) bad(`Khoá view “${key.slice(0, 50)}” không hợp lệ: chỉ a-z, 0-9, _ ; bắt đầu bằng chữ.`);
  if (!label.trim()) bad('View cần có tên.');
  if (!(VIEW_TYPES as readonly string[]).includes(type)) bad(unsupportedViewTypeMessage(type));
  if (icon && !(CUSTOM_ICONS as readonly string[]).includes(icon)) bad(`Biểu tượng “${icon}” không hợp lệ.`);
}
