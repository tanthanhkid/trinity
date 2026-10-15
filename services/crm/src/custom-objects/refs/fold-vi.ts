/** Bỏ dấu tiếng Việt để tìm không phân biệt dấu: NFD + bỏ dấu kết hợp + đ→d, rồi hạ chữ thường. */
export function foldVi(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

const VI_LOWER = 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ';
/** Cặp (từ, sang) cho `translate()` của Postgres — cùng bảng với foldVi, KHÔNG cần extension `unaccent` (Neon/PG thuần đều chạy). */
export const SQL_FOLD_FROM = VI_LOWER;
export const SQL_FOLD_TO = [...VI_LOWER].map(foldVi).join('');
