import {
  CHOICE_COLORS, LIMITS, type FieldDef, type FieldOptions, type FieldType, type SelectChoice,
} from './field-types';

/** Lỗi giá trị — service đổi thành 400 kèm danh sách lỗi theo trường. */
export class ValueError extends Error {}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;
const VN_PHONE_RE = /^0\d{9}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

function str(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string') throw new ValueError(`“${label}” phải là văn bản`);
  const s = v.trim();
  if (s.length > max) throw new ValueError(`“${label}” tối đa ${max} ký tự`);
  if (CONTROL_RE.test(s)) throw new ValueError(`“${label}” chứa ký tự điều khiển không hợp lệ`);
  return s;
}

function num(v: unknown, label: string): number {
  const n = typeof v === 'string' && NUM_RE.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ValueError(`“${label}” phải là số`);
  return n;
}

export function normalizeVnPhone(raw: string): string | null {
  const compact = raw.replace(/[\s.\-()]/g, '');
  const local = compact.startsWith('+84') ? `0${compact.slice(3)}` : compact.startsWith('84') && compact.length === 11 ? `0${compact.slice(2)}` : compact;
  return VN_PHONE_RE.test(local) ? local : null;
}

export function validYmd(s: string): boolean {
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function positiveId(v: unknown, label: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new ValueError(`“${label}” chứa mã tham chiếu không hợp lệ`);
  return n;
}

function idList(v: unknown, label: string): number[] {
  if (!Array.isArray(v)) throw new ValueError(`“${label}” phải là danh sách`);
  if (v.length > LIMITS.maxRelationValues) throw new ValueError(`“${label}” tối đa ${LIMITS.maxRelationValues} mục`);
  return [...new Set(v.map((x) => positiveId(x, label)))];
}

const LINK_TOKEN_RE = /^(?:(?:record|contact|deal|task):\d{1,10}|@?[A-Za-z]{2,4}\d{1,9})$/;

/**
 * Trường "Liên kết": danh sách thẻ — mã (`HS001`, `@HS001`) hoặc `loại:id` (`record:12`). Chỉ kiểm HÌNH DẠNG; đổi mã → tham chiếu
 * và kiểm người ghi có thấy bản ghi đích làm ở RecordValidator (cần DB). Chuỗi "HS001, KH002" cũng nhận (dán nhiều mã).
 */
function linkTokens(raw: unknown, label: string): string[] {
  const list = typeof raw === 'string' ? raw.split(/[\s,;]+/) : raw;
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new ValueError(`“${label}” phải là danh sách mã bản ghi (vd ["HS001"])`);
  const out = [...new Set((list as string[]).map((x) => x.trim().replace(/^@/, '')).filter(Boolean))];
  if (out.length > LIMITS.maxLinkValues) throw new ValueError(`“${label}” tối đa ${LIMITS.maxLinkValues} thẻ`);
  const bad = out.find((x) => !LINK_TOKEN_RE.test(x));
  if (bad !== undefined) throw new ValueError(`“${label}”: “${bad.slice(0, 30)}” không phải mã bản ghi (vd HS001)`);
  return out;
}

function scalar(f: Pick<FieldDef, 'label' | 'type' | 'options'>, v: unknown): unknown {
  const { label, type, options } = f;
  switch (type) {
    case 'text': return str(v, label, LIMITS.maxText);
    case 'long_text': return str(v, label, LIMITS.maxLongText);
    case 'number': {
      const n = num(v, label);
      if (Math.abs(n) > LIMITS.maxNumber) throw new ValueError(`“${label}” vượt giới hạn cho phép`);
      return n;
    }
    case 'currency': {
      const n = num(v, label);
      if (!Number.isSafeInteger(n)) throw new ValueError(`“${label}” là số tiền VND, phải là số nguyên`);
      if (n < 0) throw new ValueError(`“${label}” không được âm (hoàn tiền: dùng trạng thái, không nhập số âm)`);
      if (Math.abs(n) > LIMITS.maxCurrency) throw new ValueError(`“${label}” vượt giới hạn cho phép`);
      return n;
    }
    case 'percent': {
      const n = num(v, label);
      if (n < -1000 || n > 1000) throw new ValueError(`“${label}” phải trong khoảng −1000% đến 1000%`);
      return n;
    }
    case 'date': {
      const s = str(v, label, 10);
      if (!validYmd(s)) throw new ValueError(`“${label}” phải là ngày hợp lệ dạng YYYY-MM-DD`);
      return s;
    }
    case 'datetime': {
      const s = str(v, label, 40);
      const t = Date.parse(s);
      if (!Number.isFinite(t) || t < Date.UTC(1900, 0, 1) || t > Date.UTC(2200, 0, 1)) {
        throw new ValueError(`“${label}” phải là ngày giờ hợp lệ`);
      }
      return new Date(t).toISOString();
    }
    case 'boolean': {
      if (v === true || v === 'true') return true;
      if (v === false || v === 'false') return false;
      throw new ValueError(`“${label}” phải là đúng/sai`);
    }
    case 'select': {
      const s = str(v, label, 64);
      if (!(options.choices ?? []).some((c) => c.value === s)) throw new ValueError(`“${label}”: giá trị “${s.slice(0, 30)}” không nằm trong danh sách lựa chọn`);
      return s;
    }
    case 'email': {
      const s = str(v, label, 254).toLowerCase();
      if (!EMAIL_RE.test(s)) throw new ValueError(`“${label}” không phải email hợp lệ`);
      return s;
    }
    case 'phone': {
      const p = normalizeVnPhone(str(v, label, 20));
      if (!p) throw new ValueError(`“${label}” phải là số điện thoại Việt Nam (10 số, bắt đầu 0 hoặc +84)`);
      return p;
    }
    case 'url': {
      const s = str(v, label, LIMITS.maxUrl);
      let u: URL;
      try { u = new URL(s); } catch { throw new ValueError(`“${label}” không phải địa chỉ web hợp lệ`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ValueError(`“${label}” chỉ chấp nhận http:// hoặc https://`);
      return s;
    }
    case 'user': return positiveId(v, label);
    case 'multi_select': case 'relation': case 'formula': case 'link':
      throw new ValueError(`“${label}”: kiểu ${type} không xử lý ở đây`);
  }
}

/**
 * Chuẩn hoá 1 giá trị theo định nghĩa trường. Trả `null` = xoá giá trị (rỗng). Ném `ValueError` nếu sai kiểu.
 * Quan hệ (relation/user) CHỈ kiểm hình dạng (mã nguyên dương) — kiểm tồn tại/phạm vi làm ở service.
 */
export function normalizeValue(f: Pick<FieldDef, 'label' | 'type' | 'options'>, raw: unknown): unknown {
  if (f.type === 'formula') throw new ValueError(`“${f.label}” là trường công thức, tính tự động nên không nhập được`);
  if (isEmptyValue(raw)) return null;
  if (f.type === 'multi_select') {
    if (!Array.isArray(raw)) throw new ValueError(`“${f.label}” phải là danh sách`);
    if (raw.length > LIMITS.maxMultiValues) throw new ValueError(`“${f.label}” tối đa ${LIMITS.maxMultiValues} lựa chọn`);
    const allowed = new Set((f.options.choices ?? []).map((c) => c.value));
    const out = [...new Set(raw.map((x) => str(x, f.label, 64)))];
    for (const x of out) if (!allowed.has(x)) throw new ValueError(`“${f.label}”: giá trị “${x.slice(0, 30)}” không nằm trong danh sách lựa chọn`);
    return out;
  }
  if (f.type === 'relation') {
    return f.options.multiple ? idList(raw, f.label) : positiveId(Array.isArray(raw) ? raw[0] : raw, f.label);
  }
  if (f.type === 'link') return linkTokens(raw, f.label);
  return scalar(f, raw);
}

export function slugifyKey(input: string): string {
  const base = input
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(base) ? base.slice(0, 48) : `f_${base}`.slice(0, 48);
}

/** Chuẩn hoá danh sách lựa chọn của select / multi_select. */
export function normalizeChoices(raw: unknown): SelectChoice[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ValueError('Danh sách lựa chọn không được trống');
  if (raw.length > LIMITS.maxChoices) throw new ValueError(`Tối đa ${LIMITS.maxChoices} lựa chọn`);
  const seen = new Set<string>();
  return raw.map((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const label = str(o.label, `Lựa chọn ${i + 1}`, 100);
    if (!label) throw new ValueError(`Lựa chọn ${i + 1} chưa có tên`);
    let value = o.value === undefined || o.value === null || o.value === '' ? slugifyKey(label) : str(o.value, `Lựa chọn ${i + 1}`, 64);
    if (!value) throw new ValueError(`Lựa chọn ${i + 1} chưa có mã`);
    if (seen.has(value)) {
      // Cắt phần gốc trước khi nối hậu tố — nếu cắt sau, value dài 64 ký tự sẽ không bao giờ đổi và vòng lặp treo.
      const base = value;
      for (let n = i + 1; seen.has(value); n++) {
        const suffix = `_${n}`;
        value = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      }
    }
    seen.add(value);
    const color = typeof o.color === 'string' && (CHOICE_COLORS as readonly string[]).includes(o.color) ? o.color : undefined;
    return color ? { value, label, color } : { value, label };
  });
}

/**
 * Chuẩn hoá `options` theo kiểu trường (loại field lạ). Phần cần DB (relation trỏ đâu, công thức tham chiếu gì) do service kiểm.
 */
export function normalizeOptions(type: FieldType, raw: unknown): FieldOptions {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (type === 'select' || type === 'multi_select') return { choices: normalizeChoices(o.choices) };
  if (type === 'relation') {
    const multiple = o.multiple === true;
    if (o.target === 'contact') return { target: 'contact', multiple };
    const id = o.target_object_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new ValueError('Chọn thực thể đích cho trường liên kết');
    return { target_object_id: id, multiple };
  }
  if (type === 'formula') {
    const expression = typeof o.expression === 'string' ? o.expression.trim() : '';
    if (!expression) throw new ValueError('Nhập biểu thức cho trường công thức');
    const format = o.format === 'currency' || o.format === 'percent' || o.format === 'number' ? o.format : 'number';
    const decimals = typeof o.decimals === 'number' && Number.isInteger(o.decimals) && o.decimals >= 0 && o.decimals <= 6 ? o.decimals : undefined;
    return decimals === undefined ? { expression, format } : { expression, format, decimals };
  }
  return {};
}

/** Công thức đọc `percent` ra phân số, các số khác nguyên giá trị, ngày giữ chuỗi. */
export function formulaInput(type: FieldType, v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  if (type === 'percent') return typeof v === 'number' ? v / 100 : null;
  if (type === 'number' || type === 'currency') return typeof v === 'number' ? v : null;
  if (type === 'date' || type === 'datetime') return typeof v === 'string' ? v : null;
  return null;
}
