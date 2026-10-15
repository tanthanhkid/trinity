import { ExtensionInputError } from './extension-errors';

// Lịch cron 5 trường (phút giờ ngày tháng thứ): hỗ trợ dấu sao, bước (sao chia n), khoảng a-b, a-b chia n, danh sách a,b. Giờ Việt Nam (UTC+7).
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = ['phút', 'giờ', 'ngày', 'tháng', 'thứ'];
export const MIN_INTERVAL_MIN = 5;

function parseField(src: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new ExtensionInputError(`Lịch chạy không hợp lệ ở trường ${name}: "${part}"`);
    const star = m[1] === '*';
    const from = star ? lo : Number(m[2]);
    const to = star ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1 || from < lo || to > hi || from > to) throw new ExtensionInputError(`Lịch chạy ngoài phạm vi ở trường ${name}: "${part}"`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export interface CronSpec {
  fields: Set<number>[];
  /** Trường ngày và thứ đều bị giới hạn ⇒ theo cron chuẩn, khớp một trong hai. */
  dayOr: boolean;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new ExtensionInputError('Lịch chạy phải có đúng 5 trường (phút giờ ngày tháng thứ), ví dụ "0 8 * * *".');
  const fields = parts.map((p, i) => parseField(p, RANGES[i] as [number, number], NAMES[i] as string));
  return { fields, dayOr: parts[2] !== '*' && parts[4] !== '*' };
}

const VN_OFFSET_MS = 7 * 3600_000;

export function cronMatches(spec: CronSpec, at: Date): boolean {
  const d = new Date(at.getTime() + VN_OFFSET_MS);
  const [min, hour, dom, mon, dow] = spec.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !mon.has(d.getUTCMonth() + 1)) return false;
  const byDom = dom.has(d.getUTCDate());
  const byDow = dow.has(d.getUTCDay());
  return spec.dayOr ? byDom || byDow : byDom && byDow;
}

/** Kiểm cú pháp + chặn lịch dày hơn MIN_INTERVAL_MIN phút bằng cách quét 7 ngày (đủ phủ mọi thứ trong tuần). */
export function validateSchedule(expr: string): void {
  const spec = parseCron(expr);
  let last = -Infinity;
  const start = Date.UTC(2026, 0, 1, 0, 0) - VN_OFFSET_MS;
  for (let i = 0; i < 7 * 24 * 60; i++) {
    if (!cronMatches(spec, new Date(start + i * 60_000))) continue;
    if (i - last < MIN_INTERVAL_MIN) throw new ExtensionInputError(`Lịch chạy quá dày: tối thiểu ${MIN_INTERVAL_MIN} phút giữa hai lần chạy.`);
    last = i;
  }
}
