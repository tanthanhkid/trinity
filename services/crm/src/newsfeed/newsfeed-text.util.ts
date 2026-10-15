// Chuyển HTML rich-text → văn bản thuần cho preview thông báo.
// Giải mã entity ĐÚNG THỨ TỰ (&amp; cuối cùng) để `&amp;nbsp;` (dữ liệu cũ bị
// escape 2 lần) ra khoảng trắng chứ không lộ chữ "&nbsp;".
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeOnce(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&(nbsp|lt|gt|quot|apos);/gi, (_, n: string) => NAMED_ENTITIES[n.toLowerCase()])
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(cp: number): string {
  try {
    return cp === 160 ? ' ' : String.fromCodePoint(cp);
  } catch {
    return ' ';
  }
}

export function stripHtmlToText(html: string): string {
  const noTags = (html ?? '').replace(/<[^>]*>/g, ' ');
  // Giải mã 2 lượt: bắt được `&amp;nbsp;` của dữ liệu cũ bị escape 2 lần.
  return decodeOnce(decodeOnce(noTags)).replace(/\s+/g, ' ').trim();
}
