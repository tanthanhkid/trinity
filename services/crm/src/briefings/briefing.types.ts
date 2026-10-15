export type BriefingSlot = 'morning' | 'evening';

/** Số hiện tại + số cùng kỳ hôm trước (để so sánh). */
export interface Delta {
  value: number;
  prev: number;
}

export interface TopSeller {
  user_id: number;
  name: string;
  won_count: number;
  won_value: number;
}

export interface BriefingMetrics {
  newContacts: Delta;
  stageChanges: Delta;
  dealsCreated: Delta;
  dealsWon: Delta;
  /** Doanh số = tổng giá trị deal chuyển sang `won` trong kỳ (VND). */
  wonValue: Delta;
  dealsLost: Delta;
  overdueTasks: number;
  /** Lịch hẹn nhắc: sáng = hôm nay, chiều = ngày mai. */
  callbacks: number;
  topSellers: TopSeller[];
}

export type BriefingScopeKind = 'company' | 'team' | 'self';

export interface BriefingData {
  slot: BriefingSlot;
  /** Ngày VN YYYY-MM-DD của lần gửi. */
  day: string;
  /** "hôm qua" (sáng) | "hôm nay" (chiều) — nhãn kỳ số liệu. */
  periodLabel: string;
  reminderLabel: string;
  scope: BriefingScopeKind;
  peopleCount: number;
  metrics: BriefingMetrics;
}

export interface BriefingConfig {
  enabled: boolean;
  morning_enabled: boolean;
  evening_enabled: boolean;
  /** "HH:mm" giờ VN. */
  morning_time: string;
  evening_time: string;
  in_app: boolean;
}

export const DEFAULT_BRIEFING_CONFIG: BriefingConfig = {
  enabled: false,
  morning_enabled: true,
  evening_enabled: true,
  morning_time: '08:00',
  evening_time: '17:30',
  in_app: true,
};

export interface BriefingContent {
  title: string;
  /** Văn bản thuần nhiều dòng (hiện trong app). */
  text: string;
}
