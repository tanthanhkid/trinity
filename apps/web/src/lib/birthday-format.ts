/**
 * Birthday helpers — hiển thị DD/MM/YYYY (chuẩn VN), lưu YYYY-MM-DD.
 *
 * `<input type="date">` phụ thuộc locale trình duyệt → user VN hay thấy MM/DD/YYYY.
 * Dùng input text + 3 helper dưới đây để kiểm soát format độc lập locale.
 */

const BIRTHDAY_MIN_YEAR = 1900;
const BIRTHDAY_MAX_YEAR = 2100;

/** YYYY-MM-DD → DD/MM/YYYY. Trả "" nếu ISO không khớp regex (lenient). */
export function birthdayIsoToDisplay(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * DD/MM/YYYY → YYYY-MM-DD, với full calendar validation.
 * Trả "" nếu:
 *  - Format không khớp (thiếu /, thiếu digit)
 *  - Ngày/tháng out-of-range (day 1-31, month 1-12, year 1900-2100)
 *  - Ngày không tồn tại theo lịch (vd 31/02/1990, 29/02/2023 non-leap)
 */
export function birthdayDisplayToIso(display: string): string {
  const m = display.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    year < BIRTHDAY_MIN_YEAR ||
    year > BIRTHDAY_MAX_YEAR
  ) {
    return "";
  }
  // Round-trip Date(UTC) để chặn invalid calendar date (31/02, Feb 29 non-leap...).
  // Date() tự overflow tháng → 31/02/1990 = 03/03/1990. So sánh round-trip phát hiện.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return "";
  }
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Format user input realtime khi gõ/paste. Tự chèn "/" sau ngày + tháng.
 *
 * Normalize các separator thường gặp (`.`, `-`, khoảng trắng) về "/" trước khi
 * strip non-digit — giúp paste "15.03.1990" / "15-03-1990" / "15 03 1990" cũng
 * ra đúng. Giới hạn 8 chữ số (DDMMYYYY).
 */
export function formatBirthdayInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length > 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }
  if (digits.length > 2) {
    return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  }
  return digits;
}
