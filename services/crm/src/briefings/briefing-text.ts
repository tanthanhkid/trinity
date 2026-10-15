import type { BriefingContent, BriefingData, Delta } from './briefing.types';

const SCOPE_LABEL = { company: 'Toàn công ty', team: 'Nhóm của bạn', self: 'Của riêng bạn' } as const;

/** 1.250.000.000 → "1,25 tỷ"; 350.000.000 → "350 triệu"; dưới 1 triệu → "850 nghìn". */
export function formatVnd(v: number): string {
  const trim = (n: number, d: number) => n.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ',');
  if (v >= 1e9) return `${trim(v / 1e9, 2)} tỷ`;
  if (v >= 1e6) return `${trim(v / 1e6, 1)} triệu`;
  if (v >= 1e3) return `${trim(v / 1e3, 0)} nghìn`;
  return `${v} đồng`;
}

/** "(tăng 3 so với hôm trước)" / "(giảm 2 …)" / "(bằng hôm trước)". `fmt` đổi số sang chuỗi (tiền). */
export function deltaText(d: Delta, fmt: (n: number) => string = String): string {
  const diff = d.value - d.prev;
  if (diff === 0) return '(bằng hôm trước)';
  return `(${diff > 0 ? 'tăng' : 'giảm'} ${fmt(Math.abs(diff))} so với hôm trước)`;
}

function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
}

/** Dòng số liệu — nguồn duy nhất cho bản tin mẫu và dữ liệu đưa agent (không lệch nhau). */
export function buildLines(data: BriefingData): string[] {
  const m = data.metrics;
  const p = data.periodLabel;
  const lines = [
    `Khách mới ${p}: ${m.newContacts.value} ${deltaText(m.newContacts)}.`,
    `Lượt đổi giai đoạn ${p}: ${m.stageChanges.value} ${deltaText(m.stageChanges)}.`,
    `Deal ${p}: tạo mới ${m.dealsCreated.value}, thắng ${m.dealsWon.value}, thua ${m.dealsLost.value}.`,
    `Doanh số ${p}: ${formatVnd(m.wonValue.value)} ${deltaText(m.wonValue, formatVnd)}.`,
    `Việc quá hạn: ${m.overdueTasks}.`,
    `Lịch hẹn nhắc ${data.reminderLabel}: ${m.callbacks}.`,
  ];
  if (m.topSellers.length > 0) {
    const top = m.topSellers.map((s) => `${s.name} (${s.won_count} deal, ${formatVnd(s.won_value)})`).join('; ');
    lines.push(`Nổi bật ${p}: ${top}.`);
  }
  return lines;
}

/** Dựng nội dung bản tin bằng template thuần — KHÔNG có AI. Agent của khách (qua MCP) có thể viết bản khác rồi lưu đè (`save_briefing`). */
export function buildBriefingContent(data: BriefingData): BriefingContent {
  const kind = data.slot === 'morning' ? 'sáng' : 'chiều';
  const title = `Bản tin ${kind} ${dayLabel(data.day)} — ${SCOPE_LABEL[data.scope]}`;
  const closing = data.slot === 'morning' ? 'Chúc bạn một ngày làm việc hiệu quả.' : 'Cảm ơn bạn, hẹn gặp lại bản tin sáng mai.';
  const text = [title, '', ...buildLines(data).map((l) => `- ${l}`), '', closing].join('\n');
  return { title, text };
}

/** Rút gọn cho thông báo trong app (chuông): 3 gạch đầu dòng đầu; bản tin agent viết không có gạch đầu dòng thì lấy đoạn đầu. */
export function shortBody(content: BriefingContent): string {
  const bullets = content.text.split('\n').filter((l) => l.startsWith('- ')).slice(0, 3).map((l) => l.slice(2));
  if (bullets.length > 0) return bullets.join(' ');
  const body = content.text.split('\n').map((l) => l.trim()).filter((l) => l && l !== content.title).join(' ');
  return body.length > 280 ? `${body.slice(0, 279)}…` : body;
}
