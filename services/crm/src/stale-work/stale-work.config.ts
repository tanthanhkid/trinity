/** Cấu hình "việc treo" — lưu ở Setting `stale_work_config` (JSON một phần); trường sai rơi về mặc định. */
export interface StaleWorkConfig {
  /** Khách có người phụ trách mà không có tương tác nào quá N ngày. */
  contact_days: number;
  /** Deal đang mở không đổi quá N ngày (và khách của deal cũng im lặng). */
  deal_days: number;
  /** Lịch hẹn nhắc coi là LỠ sau bao nhiêu giờ kể từ giờ hẹn mà chưa có tương tác. */
  reminder_grace_hours: number;
  /** Giờ gửi tổng hợp sáng (0–23, giờ Việt Nam). */
  digest_hour: number;
}

export const DEFAULT_STALE_CONFIG: StaleWorkConfig = { contact_days: 7, deal_days: 14, reminder_grace_hours: 2, digest_hour: 8 };

const int = (v: unknown, min: number, max: number, def: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def;

export function normalizeStaleConfig(raw: unknown): StaleWorkConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STALE_CONFIG;
  return {
    contact_days: int(r.contact_days, 1, 365, d.contact_days),
    deal_days: int(r.deal_days, 1, 365, d.deal_days),
    reminder_grace_hours: int(r.reminder_grace_hours, 0, 168, d.reminder_grace_hours),
    digest_hour: int(r.digest_hour, 0, 23, d.digest_hour),
  };
}

/** Giờ + ngày hiện tại theo múi giờ Việt Nam (UTC+7, không có DST). */
export function vietnamClock(now: Date): { hour: number; date: string } {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return { hour: vn.getUTCHours(), date: vn.toISOString().slice(0, 10) };
}
