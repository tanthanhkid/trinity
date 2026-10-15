import type { BriefingSlot } from './briefing.types';

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Quá giờ hẹn tối đa bao lâu thì vẫn bù gửi (cron có thể chạy trễ hoặc thưa). */
export const SLOT_GRACE_MS = 4 * 60 * 60 * 1000;

export interface Range {
  start: Date;
  end: Date;
}

/** 00:00 hôm nay theo giờ VN, trả về instant UTC. */
export function vnDayStart(now: Date): Date {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS);
}

/** Ngày VN dạng YYYY-MM-DD. */
export function vnDayKey(now: Date): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function parseHHmm(v: string): { h: number; m: number } | null {
  const mt = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return mt ? { h: Number(mt[1]), m: Number(mt[2]) } : null;
}

/** Instant mốc gửi của slot trong ngày VN của `now`; null nếu giờ cấu hình sai. */
export function slotInstant(time: string, now: Date): Date | null {
  const p = parseHHmm(time);
  if (!p) return null;
  return new Date(vnDayStart(now).getTime() + (p.h * 60 + p.m) * 60_000);
}

/** Slot đã đến giờ gửi và còn trong thời gian bù. */
export function isSlotDue(time: string, now: Date): boolean {
  const at = slotInstant(time, now);
  if (!at) return false;
  const diff = now.getTime() - at.getTime();
  return diff >= 0 && diff < SLOT_GRACE_MS;
}

export interface SlotWindows {
  cur: Range;
  prev: Range;
  callbacks: Range;
  periodLabel: string;
  reminderLabel: string;
}

/**
 * Sáng: tổng kết trọn ngày hôm qua (so với hôm kia), lịch hẹn nhắc hôm nay.
 * Chiều: tổng kết hôm nay tới giờ (so với hôm qua CÙNG thời điểm), lịch hẹn nhắc ngày mai.
 */
export function slotWindows(slot: BriefingSlot, now: Date): SlotWindows {
  const today = vnDayStart(now);
  if (slot === 'morning') {
    const y = new Date(today.getTime() - DAY_MS);
    return {
      cur: { start: y, end: today },
      prev: { start: new Date(y.getTime() - DAY_MS), end: y },
      callbacks: { start: today, end: new Date(today.getTime() + DAY_MS) },
      periodLabel: 'hôm qua',
      reminderLabel: 'hôm nay',
    };
  }
  return {
    cur: { start: today, end: now },
    prev: { start: new Date(today.getTime() - DAY_MS), end: new Date(now.getTime() - DAY_MS) },
    callbacks: { start: new Date(today.getTime() + DAY_MS), end: new Date(today.getTime() + 2 * DAY_MS) },
    periodLabel: 'hôm nay',
    reminderLabel: 'ngày mai',
  };
}
