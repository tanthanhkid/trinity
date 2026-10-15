/**
 * Tham chiếu bản ghi dùng chung giữa mọi bảng (gắn thẻ @, trường "Liên kết", truy ngược). Một tham chiếu = `loại:id`
 * (`record:12`, `contact:5`, `deal:3`, `task:9`); hiển thị bằng MÃ (HS001, KH005…) nhưng LƯU bằng id để đổi tiền tố không gãy.
 */

export const REF_TYPES = ['record', 'contact', 'deal', 'task'] as const;
export type RefType = (typeof REF_TYPES)[number];

export interface Ref { type: RefType; id: number }

/** Một bản ghi người xem ĐƯỢC THẤY — chỉ dựng cho bản ghi đã qua kiểm quyền. */
export interface RefView {
  type: RefType;
  id: number;
  /** `record:12` — khoá lưu trong trường Liên kết. */
  ref: string;
  code: string | null;
  title: string;
  /** Tên bảng: "Sản phẩm", "Khách hàng", "Deal", "Công việc". */
  table: string;
  /** Khoá bảng tuỳ biến (chỉ `record`). */
  table_key?: string;
  /** Đường mở bản ghi trong web; null = không có trang riêng (deal không gắn khách). */
  href: string | null;
}

export const CORE_TABLE_LABEL: Record<Exclude<RefType, 'record'>, string> = { contact: 'Khách hàng', deal: 'Deal', task: 'Công việc' };

const REF_RE = /^(record|contact|deal|task):(\d{1,10})$/;

export function refKey(r: Ref): string {
  return `${r.type}:${r.id}`;
}

export function parseRef(raw: unknown): Ref | null {
  if (typeof raw !== 'string') return null;
  const m = REF_RE.exec(raw.trim());
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type: m[1] as RefType, id } : null;
}

/**
 * Mã được nhắc trong văn bản: `@HS001` (không phân biệt hoa thường), không dính sau chữ/số/@ (email `a@hs001.vn` không tính).
 * Trả mã CHUẨN (in hoa, đệm 3 số), không trùng, giữ thứ tự xuất hiện, tối đa `max`.
 */
export const MENTION_RE = /(^|[^\p{L}\p{N}_@])@([A-Za-z]{2,4})(\d{1,9})(?![\p{L}\p{N}_])/gu;

export function extractMentionCodes(text: string, max = 50): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const seq = Number(m[3]);
    if (!Number.isSafeInteger(seq) || seq <= 0) continue;
    const code = `${m[2].toUpperCase()}${seq < 1000 ? String(seq).padStart(3, '0') : String(seq)}`;
    if (!out.includes(code)) out.push(code);
    if (out.length >= max) break;
  }
  return out;
}
