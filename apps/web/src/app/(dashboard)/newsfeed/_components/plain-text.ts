// Chữ thuần của nội dung bài (HTML từ RichTextEditor) — dùng chung cho soạn và sửa bài.

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Chữ thuần của HTML bài (bỏ thẻ, giải mã entity) — để đếm ký tự và kiểm rỗng. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .trim()
}
