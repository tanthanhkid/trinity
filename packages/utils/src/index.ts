/**
 * Format number as Vietnamese currency
 * formatVND(1200000) → "1.200.000 VNĐ"
 */
export function formatVND(amount: number): string {
  return amount.toLocaleString('vi-VN') + ' VNĐ'
}

/**
 * Format currency short
 * formatCurrencyShort(1200000000) → "1.2 tỷ"
 */
export function formatCurrencyShort(amount: number): string {
  if (amount >= 1_000_000_000) {
    const val = amount / 1_000_000_000
    return val % 1 === 0 ? `${val} tỷ` : `${val.toFixed(1)} tỷ`
  }
  if (amount >= 1_000_000) return `${Math.round(amount / 1_000_000)}tr`
  return amount.toLocaleString('vi-VN')
}

/**
 * Normalize phone number to 0xxxxxxxxx format.
 *
 * normalizePhone("+84912345678") → "0912345678"
 * normalizePhone("84912345678")  → "0912345678"
 * normalizePhone("0912345678")   → "0912345678"
 * normalizePhone("912345678")    → "0912345678" (Excel hay drop leading 0 khi
 *                                  cell lưu dạng number).
 */
export function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.startsWith('84') && cleaned.length === 11) {
    return '0' + cleaned.slice(2)
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return cleaned
  }
  // Excel number-format strip leading zero: "912345678" → cần thêm '0' đầu.
  // Chỉ áp dụng khi đúng 9 chữ số và prefix khớp mobile VN: 3x, 5x, 7x, 8x, 9x.
  // KHÔNG có 4x/6x (đầu số mobile VN 2026: Viettel 03/08/09, MobiFone 07/09,
  // VinaPhone 08/09, Vietnamobile 05/09, Gmobile 05/09, Itelecom 08/09).
  if (cleaned.length === 9 && /^[35789]/.test(cleaned)) {
    return '0' + cleaned
  }
  return cleaned
}

/**
 * Format phone for display
 * formatPhone("0912345678") → "0912 345 678"
 */
export function formatPhone(phone: string): string {
  const normalized = normalizePhone(phone)
  if (normalized.length === 10) {
    return `${normalized.slice(0, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7)}`
  }
  return phone
}

/**
 * Mask phone number for privacy
 * maskPhone("0912345678") → "0912***678"
 */
export function maskPhone(phone: string): string {
  const normalized = normalizePhone(phone)
  if (normalized.length >= 10) {
    return `${normalized.slice(0, 4)}***${normalized.slice(-3)}`
  }
  return phone
}

/**
 * Validate Vietnamese phone number
 * isValidPhone("0912345678") → true
 * isValidPhone("+84912345678") → true
 */
export function isValidPhone(phone: string): boolean {
  return /^(0|\+84)\d{9}$/.test(phone)
}

/**
 * Format date to DD/MM/YYYY
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/**
 * Format datetime to DD/MM/YYYY HH:mm
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
