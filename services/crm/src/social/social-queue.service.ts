import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { MAX_SCHEDULE_AHEAD_MS } from './social.config';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Giờ Việt Nam = UTC+7, không có giờ mùa hè. */
const VN_OFFSET_MS = 7 * 3_600_000;
export const MAX_QUEUE_SLOTS = 100;
/** Khung phải cách bây giờ ít nhất chừng này (đủ để bài còn sửa/huỷ được). */
export const QUEUE_MIN_LEAD_MS = 2 * MINUTE;
export const NO_QUEUE_SLOTS = 'Chưa đặt khung giờ hàng đợi (Đăng đa kênh › Lịch › Khung giờ)';

export interface QueueSlot {
  weekday: number;
  minute: number;
}

/** Thứ (0 = Chủ nhật … 6) + phút trong ngày giờ Việt Nam → thời điểm UTC ĐẦU TIÊN sau `after` (ms). */
export function slotAfter(slot: QueueSlot, after: number): Date {
  const vn = after + VN_OFFSET_MS;
  const dayStart = Math.floor(vn / DAY) * DAY;
  const today = new Date(dayStart).getUTCDay();
  let t = dayStart + ((slot.weekday - today + 7) % 7) * DAY + slot.minute * MINUTE;
  if (t <= vn) t += 7 * DAY;
  return new Date(t - VN_OFFSET_MS);
}

/** Các lần xảy ra của danh sách khung, theo thứ tự thời gian, sau `after` và không quá `until` (ms). */
export function occurrences(slots: QueueSlot[], after: number, until: number): Date[] {
  const out: Date[] = [];
  for (const s of slots) {
    for (let d = slotAfter(s, after); d.getTime() <= until; d = new Date(d.getTime() + 7 * DAY)) out.push(d);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const bad = (m: string) => new BadRequestException(m);

@Injectable()
export class SocialQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /** Khung giờ theo thứ rồi theo giờ. */
  async slots(): Promise<QueueSlot[]> {
    const rows = await this.prisma.socialQueueSlot.findMany({ orderBy: [{ weekday: 'asc' }, { minute: 'asc' }] });
    return rows.map((r) => ({ weekday: r.weekday, minute: r.minute }));
  }

  /** Thay toàn bộ danh sách khung trong một transaction. */
  async setSlots(list: QueueSlot[]): Promise<QueueSlot[]> {
    if (!Array.isArray(list)) throw bad('slots phải là danh sách.');
    const seen = new Map<string, QueueSlot>();
    for (const s of list) {
      if (!s || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) throw bad('Thứ phải từ 0 (Chủ nhật) đến 6 (Thứ bảy).');
      if (!Number.isInteger(s.minute) || s.minute < 0 || s.minute > 1439) throw bad('Giờ phải từ 00:00 đến 23:59.');
      seen.set(`${s.weekday}:${s.minute}`, { weekday: s.weekday, minute: s.minute });
    }
    if (seen.size > MAX_QUEUE_SLOTS) throw bad(`Tối đa ${MAX_QUEUE_SLOTS} khung giờ.`);
    const data = [...seen.values()].sort((a, b) => a.weekday - b.weekday || a.minute - b.minute);
    await this.prisma.$transaction(async (tx) => {
      await tx.socialQueueSlot.deleteMany({});
      if (data.length) await tx.socialQueueSlot.createMany({ data });
    });
    return data;
  }

  /** `count` khung trống gần nhất: sau now + 2 phút, trong 90 ngày, bỏ khung đã có bài hẹn cùng phút. Rỗng khi chưa có khung. */
  async nextFree(count = 1, now = Date.now()): Promise<Date[]> {
    const n = Math.min(Math.max(Math.floor(count) || 1, 1), 50);
    const slots = await this.slots();
    if (slots.length === 0) return [];
    const from = now + QUEUE_MIN_LEAD_MS;
    const until = now + MAX_SCHEDULE_AHEAD_MS;
    const all = occurrences(slots, from, until);
    if (all.length === 0) return [];
    const taken = await this.prisma.socialPost.findMany({
      where: { status: 'scheduled', scheduled_at: { gte: new Date(all[0].getTime() - MINUTE), lte: new Date(all[all.length - 1].getTime() + MINUTE) } },
      select: { scheduled_at: true },
    });
    const used = new Set(taken.map((p) => Math.floor(p.scheduled_at!.getTime() / MINUTE)));
    return all.filter((d) => !used.has(Math.floor(d.getTime() / MINUTE))).slice(0, n);
  }

  /** Khung `at` còn dùng được: còn ≥ 1 phút nữa mới tới và chưa có bài hẹn cùng phút (kiểm lại lúc chạy đề xuất đã duyệt). */
  async isFree(at: Date, now = Date.now()): Promise<boolean> {
    if (at.getTime() < now + MINUTE) return false;
    const start = new Date(Math.floor(at.getTime() / MINUTE) * MINUTE);
    const taken = await this.prisma.socialPost.count({ where: { status: 'scheduled', scheduled_at: { gte: start, lt: new Date(start.getTime() + MINUTE) } } });
    return taken === 0;
  }
}
