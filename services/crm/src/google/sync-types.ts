export interface RunStats {
  /** Dòng đọc được từ Sheet (nhập) hoặc dòng đã ghi ra Sheet (xuất). */
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  duplicates_in_sheet: number;
  invalid: number;
  errors: number;
  /** Tối đa 20 thông báo lỗi theo dòng — KHÔNG chứa SĐT/email. */
  error_samples: string[];
  note?: string;
}

export const emptyStats = (): RunStats => ({ read: 0, created: 0, updated: 0, unchanged: 0, duplicates_in_sheet: 0, invalid: 0, errors: 0, error_samples: [] });

export function addError(stats: RunStats, row: number, msg: string): void {
  stats.errors++;
  if (stats.error_samples.length < 20) stats.error_samples.push(`Dòng ${row}: ${msg.slice(0, 160)}`);
}
