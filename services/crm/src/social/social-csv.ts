import { BadRequestException } from '@nestjs/common';

/** Nhập nhiều bài từ CSV: tối đa 200 dòng, 1 MB chữ. */
export const IMPORT_MAX_ROWS = 200;
export const IMPORT_MAX_BYTES = 1024 * 1024;

export type CsvDelimiter = ',' | ';';

export interface CsvRecord {
  /** Dòng bắt đầu bản ghi trong tệp (1 = dòng tiêu đề); trường nhiều dòng trong ngoặc kép vẫn tính dòng đầu. */
  line: number;
  cells: string[];
}

/** Dấu phân cách theo dòng tiêu đề: dấu nào (ngoài ngoặc kép) nhiều hơn thì dùng; hoà ⇒ dấu phẩy. */
export function detectDelimiter(text: string): CsvDelimiter {
  let comma = 0;
  let semi = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted) {
      if (ch === '\n' || ch === '\r') break;
      if (ch === ',') comma++;
      else if (ch === ';') semi++;
    }
  }
  return semi > comma ? ';' : ',';
}

/**
 * Bóc CSV theo RFC 4180: trường trong ngoặc kép (chứa dấu phân cách / xuống dòng), `""` = một dấu nháy, CRLF/LF/CR,
 * bỏ BOM UTF-8. Dòng trống hoàn toàn bị bỏ. Ngoặc kép không đóng ⇒ 400.
 */
export function parseCsvRecords(text: string, delimiter?: CsvDelimiter): { delimiter: CsvDelimiter; records: CsvRecord[] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? detectDelimiter(src);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;
  let quoteLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) records.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      quoteLine = line;
    } else if (ch === d) endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else cell += ch;
  }
  if (quoted) throw new BadRequestException(`CSV: dấu ngoặc kép mở ở dòng ${quoteLine} không được đóng.`);
  if (cell !== '' || cells.length > 0 || wasQuoted) endRecord();
  return { delimiter: d, records };
}

/** Dòng nhập đã chuẩn về tên cột chính (trường trống = undefined / mảng rỗng). */
export interface ImportRowInput {
  /** Số dòng (CSV: dòng trong tệp, dòng tiêu đề là 1; MCP: thứ tự 1…n). */
  row: number;
  content?: string;
  /** id kênh (dạng số) hoặc tên kênh đúng như hiển thị. */
  channels: string[];
  /** Giờ Việt Nam `YYYY-MM-DD HH:mm` / `DD/MM/YYYY HH:mm` / ISO 8601; `queue` hoặc `hang doi` = hàng đợi. */
  scheduled_at?: string;
  use_queue?: boolean;
  /** Khoá tệp hoặc tên tệp trong thư viện. */
  media: string[];
  first_comment?: string;
  youtube_title?: string;
  utm_campaign?: string;
}

/** Bỏ dấu, thường hoá, mọi ký tự không phải chữ/số thành `_`. */
export function normHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const ALIASES: Record<string, keyof Omit<ImportRowInput, 'row' | 'use_queue'>> = {
  content: 'content',
  noi_dung: 'content',
  channels: 'channels',
  channel: 'channels',
  kenh: 'channels',
  scheduled_at: 'scheduled_at',
  gio_dang: 'scheduled_at',
  media: 'media',
  tep: 'media',
  first_comment: 'first_comment',
  binh_luan_dau: 'first_comment',
  youtube_title: 'youtube_title',
  tieu_de_youtube: 'youtube_title',
  utm_campaign: 'utm_campaign',
  utm: 'utm_campaign',
};

const QUEUE_WORDS = new Set(['queue', 'hang_doi']);
export const isQueueWord = (v: string): boolean => QUEUE_WORDS.has(normHeader(v));

const splitList = (v: string, seps: RegExp): string[] => v.split(seps).map((s) => s.trim()).filter(Boolean);

/** CSV → các dòng nhập (có số dòng). Kiểm giới hạn kích thước/số dòng và cột bắt buộc. */
export function parseCsv(text: string): { delimiter: CsvDelimiter; rows: ImportRowInput[]; unknown_columns: string[] } {
  if (typeof text !== 'string' || !text.trim()) throw new BadRequestException('CSV trống.');
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) throw new BadRequestException('CSV tối đa 1 MB.');
  const { delimiter, records } = parseCsvRecords(text);
  if (records.length === 0) throw new BadRequestException('CSV trống.');
  const [head, ...body] = records;
  const cols = new Map<number, keyof Omit<ImportRowInput, 'row' | 'use_queue'>>();
  const unknown: string[] = [];
  const seen = new Set<string>();
  head.cells.forEach((h, i) => {
    const key = ALIASES[normHeader(h)];
    if (!key) {
      if (h.trim()) unknown.push(h.trim());
      return;
    }
    if (seen.has(key)) throw new BadRequestException(`CSV: cột "${h.trim()}" trùng với một cột đã có.`);
    seen.add(key);
    cols.set(i, key);
  });
  if (!seen.has('content') && !seen.has('media')) throw new BadRequestException('CSV cần dòng tiêu đề có cột content (noi_dung) hoặc media (tep).');
  if (body.length === 0) throw new BadRequestException('CSV chưa có dòng dữ liệu nào.');
  if (body.length > IMPORT_MAX_ROWS) throw new BadRequestException(`Tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần nhập (CSV có ${body.length}).`);
  const rows = body.map((r): ImportRowInput => {
    const row: ImportRowInput = { row: r.line, channels: [], media: [] };
    cols.forEach((key, i) => {
      const v = (r.cells[i] ?? '').trim();
      if (!v) return;
      if (key === 'channels') row.channels = splitList(v, /[;,]/);
      else if (key === 'media') row.media = splitList(v, /;/);
      else if (key === 'scheduled_at') {
        if (isQueueWord(v)) row.use_queue = true;
        else row.scheduled_at = v;
      } else (row as unknown as Record<string, string>)[key] = v;
    });
    return row;
  });
  return { delimiter, rows, unknown_columns: unknown };
}

/** Giờ Việt Nam (UTC+7, không giờ mùa hè) → Date. Nhận `YYYY-MM-DD HH:mm[:ss]`, `YYYY-MM-DDTHH:mm`, `DD/MM/YYYY HH:mm`, hoặc ISO có múi giờ. Sai ⇒ ném Error tiếng Việt. */
export function parseVnTime(raw: string): Date {
  const s = raw.trim();
  const bad = () => new Error(`Giờ "${s.slice(0, 40)}" không đúng dạng — dùng YYYY-MM-DD HH:mm hoặc DD/MM/YYYY HH:mm (giờ Việt Nam).`);
  let y: number, mo: number, d: number, h: number, mi: number, sec: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) [y, mo, d, h, mi, sec] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) [d, mo, y, h, mi, sec] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  else {
    // ISO 8601 có múi giờ rõ ràng (MCP / máy khác gửi).
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
      const t = new Date(s);
      if (!Number.isNaN(t.getTime())) return t;
    }
    throw bad();
  }
  const t = new Date(Date.UTC(y, mo - 1, d, h - 7, mi, sec));
  // Khứ hồi để bắt ngày không có thật (31/02, tháng 13, giờ 25).
  const vn = new Date(t.getTime() + 7 * 3_600_000);
  if (vn.getUTCFullYear() !== y || vn.getUTCMonth() !== mo - 1 || vn.getUTCDate() !== d || vn.getUTCHours() !== h || vn.getUTCMinutes() !== mi) throw bad();
  return t;
}
