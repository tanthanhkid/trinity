export type Part = { key: string; digit: number; order: number } | { key: string; text: string }

/** Tách chuỗi thành chữ số (khoá theo hàng tính từ phải sang của cụm số đầu tiên) và phần chữ còn lại. */
export function rollingParts(text: string): Part[] {
  const digitsTotal = (text.match(/\d/g) ?? []).length
  let place = digitsTotal
  let order = 0
  return Array.from(text).map((ch, i): Part => {
    if (/\d/.test(ch)) return { key: `d${--place}`, digit: Number(ch), order: order++ }
    return { key: `t${i}-${ch}`, text: ch }
  })
}
