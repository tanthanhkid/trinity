import { ForbiddenException } from '@nestjs/common';
import { can } from '@trinity/rbac';
import { maskPhone, type AuthUser } from '@trinity/rbac-nest';
import { CreateContactDto } from '../../../contacts/dto/create-contact.dto';
import type { ObjectDef } from '../../../custom-objects/custom-object-access';
import type { RecordData } from '../../../custom-objects/field-types';
import { optInt, type Z } from '../tools/tool-types';
import { ActionUserError, type ActionDeps, type ActionToolDef, type DetailLine } from './action-types';
import { cleanText, line, lines, optionLabel, shown, validateDto } from './action-helpers';
import { loadDefForAction } from './action-view-tools';
import { checkCustom, errorPreview, errText, MAX_REPORTED_ERRORS, reportErrors, writeTables, type Checked, type RowError } from './import-custom';
import { remember, type Pending } from './ref-resolver';

export const MAX_IMPORT_ROWS = 500;
const CONTACT_KEYS = ['full_name', 'phone', 'phone_2', 'email', 'job_title', 'company_name', 'zalo_account', 'source_id', 'stage_id'];

function parseRows(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ActionUserError('rows cần ít nhất 1 dòng {khoá_trường: giá trị}.');
  if (raw.length > MAX_IMPORT_ROWS) throw new ActionUserError(`Mỗi lô tối đa ${MAX_IMPORT_ROWS} dòng — hãy chia nhỏ và gọi import_records nhiều lần.`);
  if (JSON.stringify(raw).includes('\\u0000')) throw new ActionUserError('rows chứa ký tự không hợp lệ.');
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ActionUserError(`Dòng ${i + 1} phải là object {khoá_trường: giá trị}.`);
    return r as Record<string, unknown>;
  });
}

async function checkContacts(deps: ActionDeps, rows: Record<string, unknown>[], sourceId?: number): Promise<Checked> {
  const valid: RecordData[] = [];
  const errors: RowError[] = [];
  const rowNumbers: number[] = [];
  const okOptions = new Map<string, boolean>();
  for (const [i, row] of rows.entries()) {
    try {
      const plain = Object.fromEntries(Object.entries(row).filter(([k]) => CONTACT_KEYS.includes(k)).map(([k, v]) => [k, typeof v === 'string' ? cleanText(v, 200) : v]));
      const extra = Object.keys(row).filter((k) => !CONTACT_KEYS.includes(k));
      if (extra.length) throw new ActionUserError(`cột không thuộc khách hàng: ${extra.slice(0, 5).join(', ')} (dùng: ${CONTACT_KEYS.join(', ')})`);
      if (plain.source_id === undefined && sourceId) plain.source_id = sourceId;
      const dto = await validateDto(CreateContactDto, plain);
      for (const [id, group, name] of [[dto.source_id, 'contact_source', 'source_id'], [dto.stage_id, 'contact_stage', 'stage_id']] as const) {
        if (!id) continue;
        const k = `${group}:${id}`;
        if (!okOptions.has(k)) okOptions.set(k, await optionLabel(deps, id, group, name).then(() => true));
      }
      valid.push(plain as RecordData);
      rowNumbers.push(i + 1);
    } catch (e) {
      errors.push({ row: i + 1, reason: errText(e) });
    }
  }
  return { valid, errors, rowNumbers };
}

function preview(def: ObjectDef | null, rows: RecordData[]): string {
  return rows.slice(0, 3).map((r) => Object.entries(r).slice(0, 6).map(([k, v]) => {
    const f = def?.fields.find((x) => x.key === k);
    const isPhone = f ? f.type === 'phone' : k === 'phone' || k === 'phone_2';
    const show = (x: unknown): string => (x && typeof x === 'object' ? JSON.stringify((x as { $key?: unknown }).$key ?? x) : String(x));
    return `${f?.label ?? k}: ${isPhone ? (maskPhone(String(v)) ?? '***') : Array.isArray(v) ? v.map(show).join(', ') : show(v)}`;
  }).join(' | ')).join('\n');
}

function details(label: string, mapping: Record<string, string> | null, c: Checked, def: ObjectDef | null, total: number, source: string): DetailLine[] {
  return lines(
    line('Bảng', label), line('Nguồn', source), line('Số dòng', `${total} dòng gửi lên — ${c.valid.length} hợp lệ sẽ ghi, ${c.errors.length} dòng lỗi bị bỏ qua`),
    line('Cột ghép', mapping ? Object.entries(mapping).map(([src, dst]) => `${src} → ${dst}`).join('; ') : Object.keys(c.valid[0] ?? {}).join(', '), 900),
    line('Dòng lỗi', c.errors.slice(0, 8).map((e) => `Dòng ${e.row}: ${e.reason}`).join('\n') || '(không)', 1200),
    line('Xem trước', preview(def, c.valid) || '(không có dòng hợp lệ)', 900),
  );
}

/** Lỗi đã bỏ qua lúc kiểm (lưu trong params của thao tác) — đọc an toàn cả với bản nháp cũ chưa có trường này. */
function storedErrors(p: Record<string, unknown>): { errors: RowError[]; total: number } {
  const errors = Array.isArray(p.errors) ? (p.errors as RowError[]) : [];
  return { errors, total: typeof p.error_total === 'number' ? p.error_total : errors.length };
}

/** Lỗi lúc kiểm (đã cắt ở trần) + lỗi lúc ghi; tổng = tổng thật của cả hai. */
function mergeErrors(stored: { errors: RowError[]; total: number }, more: RowError[]): { errors: RowError[]; error_total: number } {
  const r = reportErrors([...stored.errors, ...more]);
  return { errors: r.errors, error_total: stored.total + more.length };
}

/** Lưu kèm params: số dòng gốc của từng dòng hợp lệ + các dòng đã bỏ qua lúc kiểm (để kết quả báo lại cho AI). */
function importMeta(c: Checked): { row_numbers: number[]; errors: RowError[]; error_total: number } {
  return { row_numbers: c.rowNumbers, ...reportErrors(c.errors) };
}

async function writeContacts(deps: ActionDeps, user: AuthUser, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!can(user.grants, 'contacts.create')) throw new ForbiddenException('Bạn không còn quyền tạo khách hàng (contacts.create).');
  const rows = params.rows as RecordData[];
  const rowNumbers = Array.isArray(params.row_numbers) ? (params.row_numbers as number[]) : [];
  let created = 0;
  const failed: RowError[] = [];
  for (const [i, r] of rows.entries()) {
    try {
      await deps.contacts.create(await validateDto(CreateContactDto, r), user);
      created += 1;
    } catch (e) {
      failed.push({ row: rowNumbers[i] ?? i + 1, reason: e instanceof Error ? e.message.slice(0, 200) : 'lỗi' });
    }
  }
  const stored = storedErrors(params);
  return { object: 'contacts', created, failed: failed.length, skipped: stored.total, ...mergeErrors(stored, failed), open_at: '/contacts' };
}

/** Kết quả bảng tuỳ biến: ghi tất-cả-hoặc-không, nên lỗi chỉ là các dòng đã bỏ qua lúc kiểm. */
async function writeCustomImport(deps: ActionDeps, user: AuthUser, tables: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const res = await writeTables(deps, user, tables.map((t) => ({ object: String(t.object), rows: t.rows as RecordData[] })));
  const all = tables.map((t) => storedErrors(t));
  const errs = all.flatMap((x, i) => x.errors.map((e) => (tables.length > 1 ? { ...e, object: String(tables[i].object) } : e)));
  const total = all.reduce((s, x) => s + x.total, 0);
  return { ...res, skipped: total, errors: errs.slice(0, MAX_REPORTED_ERRORS), error_total: total };
}

const MAX_TABLES = 5;
const LINK_HELP =
  'LIÊN KẾT trong cùng lượt: trường relation/link nhận id, MÃ chung ("SP001", "KH012") hoặc KHOÁ NGHIỆP VỤ {"ma_kh": "C001"} (relation: tra trong bảng đích theo trường ma_kh; ' +
  'link: thêm "object": {"object": "khach_hang", "ma_kh": "C001"}). Bảng cha chưa có dữ liệu thì `tables` nhận cả hai bảng (cha trước, con sau), con tham chiếu cha bằng khoá nghiệp vụ, ' +
  'và một lần ghi cả hai. Ô chữ dài gắn thẻ bằng @MÃ (vd "Gọi lại cho @KH001").';

interface TableIn { object: string; rows: Record<string, unknown>[]; mapping: Record<string, string> | null }

function readMapping(raw: unknown): Record<string, string> | null {
  return raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).slice(0, 60).map(([k, v]) => [cleanText(k, 80), cleanText(v, 48)])) : null;
}

function readTables(args: Record<string, unknown>): TableIn[] {
  if (Array.isArray(args.tables) && args.tables.length) {
    if (args.object || args.rows) throw new ActionUserError('Dùng MỘT trong hai: object + rows (một bảng) HOẶC tables (nhiều bảng).');
    if (args.tables.length > MAX_TABLES) throw new ActionUserError(`Tối đa ${MAX_TABLES} bảng mỗi lần.`);
    return args.tables.map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const object = cleanText(o.object, 48);
      if (object === 'contacts') throw new ActionUserError('contacts (khách hàng) nhập riêng bằng object="contacts"; trong tables chỉ dùng bảng tuỳ biến.');
      return { object, rows: parseRows(o.rows), mapping: readMapping(o.mapping) };
    });
  }
  return [{ object: cleanText(args.object, 48), rows: parseRows(args.rows), mapping: readMapping(args.mapping) }];
}

async function prepareContacts(deps: ActionDeps, user: AuthUser, t: TableIn, sourceId: number | undefined, source: string) {
  if (!can(user.grants, 'contacts.create')) throw new ForbiddenException('Bạn không có quyền tạo khách hàng (contacts.create).');
  const c = await checkContacts(deps, t.rows, sourceId);
  if (c.valid.length === 0) throw new ActionUserError(`Không có dòng nào hợp lệ (${c.errors.length} dòng lỗi). ${errorPreview(c.errors)}`);
  return { params: { object: 'contacts', rows: c.valid, ...importMeta(c) }, summary: shown(`Nhập ${c.valid.length} khách hàng${c.errors.length ? ` (bỏ ${c.errors.length} dòng lỗi)` : ''} từ ${source}`), details: details('Khách hàng [contacts]', t.mapping, c, null, t.rows.length, source) };
}

export const importRecordsAction: ActionToolDef = {
  name: 'import_records',
  label: 'Nhập dữ liệu hàng loạt',
  title: 'Nhập một lô dữ liệu từ Google Sheet / Excel / Bulk import',
  description:
    `Nhập một LÔ tối đa ${MAX_IMPORT_ROWS} dòng vào một bảng (bảng tuỳ biến, hoặc "contacts" = khách hàng), hoặc tối đa ${MAX_TABLES} bảng tuỳ biến cùng lúc qua \`tables\`. ` +
    'rows = các dòng đã ghép cột vào khoá trường (khoá lấy từ describe_schema); mapping {cột nguồn: khoá trường} lưu lại trong lịch sử để xem cách ghép. select = value của lựa chọn, date = YYYY-MM-DD. ' +
    LINK_HELP + ' Hệ thống kiểm từng dòng trước khi ghi: dòng lỗi bị bỏ qua và được báo lại trong result.errors [{row, reason}] (tối đa ' + MAX_REPORTED_ERRORS + ' dòng, tổng ở error_total; row = thứ tự dòng trong rows, từ 1); ghi ngay (nhiều bảng: bảng sau lỗi thì bảng trước cũng không ghi). Xác nhận với người dùng trước khi nhập số lượng lớn. ' +
    'Mỗi lần tối đa 500 dòng. Kết quả trả mã các bản ghi mới (vd SP001 … SP040). contacts cần full_name, phone, source_id (list_crm_options). / Imports rows immediately (one table, or several linked tables in one run).',
  permissions: ['custom_records.manage'],
  destructive: false,
  idempotent: false,
  input: (z: Z) => ({
    object: z.string().min(1).max(48).optional().describe('Khoá bảng (describe_schema) hoặc "contacts" — khi nhập MỘT bảng / Table key'),
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_IMPORT_ROWS).optional().describe('Các dòng {khoá_trường: giá trị} đã ghép cột / Rows keyed by field key'),
    mapping: z.record(z.string(), z.string()).optional().describe('{tên cột trong file: khoá trường} — để người duyệt thấy cách ghép / Column mapping'),
    tables: z.array(z.object({
      object: z.string().min(1).max(48), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_IMPORT_ROWS), mapping: z.record(z.string(), z.string()).optional(),
    })).min(1).max(MAX_TABLES).optional().describe('NHIỀU bảng trong một lần duyệt, theo thứ tự cha → con (con tham chiếu cha bằng khoá nghiệp vụ) / Several linked tables'),
    source: z.string().max(300).optional().describe('Tên file / link Sheet và phần (vd "Sheet Khách 2026, dòng 1–500") / Source'),
    source_id: z.number().int().min(1).max(2_147_483_647).optional().describe('contacts: nguồn khách chung cho cả lô / Contact source id'),
  }),
  async prepare(args, { deps, user }) {
    const tables = readTables(args);
    const source = cleanText(args.source, 300) || '(AI không ghi nguồn)';
    if (tables.length === 1 && tables[0].object === 'contacts') return prepareContacts(deps, user, tables[0], optInt(args.source_id), source);
    const pending: Pending = new Map();
    const out: Record<string, unknown>[] = [];
    const info: { def: ObjectDef; c: Checked; t: TableIn }[] = [];
    for (const t of tables) {
      const def = await loadDefForAction(deps, user, t.object);
      const c = await checkCustom(deps, user, def, t.rows, pending);
      if (c.valid.length === 0) throw new ActionUserError(`Không có dòng nào hợp lệ${tables.length > 1 ? ` ở bảng “${t.object}”` : ''} (${c.errors.length} dòng lỗi). ${errorPreview(c.errors)}`);
      remember(pending, t.object, c.valid);
      out.push({ object: t.object, rows: c.valid, ...importMeta(c) });
      info.push({ def, c, t });
    }
    const bad = info.reduce((s, x) => s + x.c.errors.length, 0);
    const what = info.map((x) => `${x.c.valid.length} ${x.def.obj.label_plural}`).join(' + ');
    return {
      params: tables.length === 1 ? out[0] : { tables: out },
      summary: shown(`Nhập ${what}${bad ? ` (bỏ ${bad} dòng lỗi)` : ''} từ ${source}`),
      details: info.flatMap((x) => details(`${x.def.obj.label_plural} [${x.def.obj.key}]`, x.t.mapping, x.c, x.def, x.t.rows.length, source)),
    };
  },
  async execute(params, { deps, user }) {
    if (Array.isArray(params.tables)) return writeCustomImport(deps, user, params.tables as Record<string, unknown>[]);
    return params.object === 'contacts' ? writeContacts(deps, user, params) : writeCustomImport(deps, user, [params]);
  },
};
