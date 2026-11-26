//! Tiếng Việt: bỏ dấu để tìm kiếm và so sánh chuỗi theo locale.
//!
//! Chuyển từ `services/crm/src/custom-objects/refs/fold-vi.ts` và `common/helpers/fold-search.helper.ts`.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::CollatorPreferences;
use icu_collator::options::CollatorOptions;
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale_core::locale;
use icu_normalizer::DecomposingNormalizerBorrowed;

/// Bỏ dấu tiếng Việt để tìm không phân biệt dấu: NFD, bỏ dấu kết hợp U+0300–U+036F, `đ`/`Đ` → `d`, rồi hạ chữ thường.
/// Giống `foldVi` của bản TS (`s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()`).
pub fn fold_vi(s: &str) -> String {
    let nfd = DecomposingNormalizerBorrowed::new_nfd().normalize(s);
    let stripped: String = nfd
        .chars()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .map(|c| if c == 'đ' || c == 'Đ' { 'd' } else { c })
        .collect();
    stripped.to_lowercase()
}

/// Chữ thường có dấu của tiếng Việt, đối số "từ" của `translate()` trong Postgres (giống `SQL_FOLD_FROM` của bản TS).
pub const SQL_FOLD_FROM: &str = "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ";
/// Đối số "sang" của `translate()`: từng ký tự của [`SQL_FOLD_FROM`] qua [`fold_vi`] (giống `SQL_FOLD_TO`).
pub const SQL_FOLD_TO: &str = "aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd";

/// Tên cột hoặc biểu thức định danh đưa thẳng vào SQL: chỉ nhận `[a-z_][a-z0-9_]*` (có thể có tiền tố `bảng.`), kiểm
/// lúc tạo, để [`fold_sql`] không thành đường chèn SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqlIdent(&'static str);

impl SqlIdent {
    /// Định danh hằng; sai dạng thì dừng (lúc biên dịch nếu gọi trong ngữ cảnh `const`).
    pub const fn new(s: &'static str) -> Self {
        let b = s.as_bytes();
        assert!(!b.is_empty(), "định danh SQL rỗng");
        let mut i = 0;
        let mut start = true;
        while i < b.len() {
            let c = b[i];
            let ok = c == b'_' || c.is_ascii_lowercase() || (!start && c.is_ascii_digit());
            assert!(
                ok || (c == b'.' && !start && i + 1 < b.len()),
                "định danh SQL chỉ gồm [a-z0-9_.]"
            );
            start = c == b'.';
            i += 1;
        }
        Self(s)
    }

    /// Chuỗi định danh.
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// Biểu thức SQL đã gập (chữ thường, bỏ dấu) của cột `column`, tham số `$from_param`/`$to_param` lần lượt là
/// [`SQL_FOLD_FROM`] và [`SQL_FOLD_TO`]: `translate(lower(cột), $n, $m)`. So với mẫu [`fold_contains`] bằng
/// `LIKE … ESCAPE '\'` (`foldSql` của bản TS).
pub fn fold_sql(column: SqlIdent, from_param: u32, to_param: u32) -> String {
    format!("translate(lower({}), ${from_param}, ${to_param})", column.as_str())
}

/// Thoát `\`, `%`, `_` cho mẫu `LIKE … ESCAPE '\'` (giống `escapeLike` của bản TS).
pub fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Mẫu LIKE "chứa" của từ khoá đã gập: `" Mính "` → `"%minh%"` (giống `foldContains` của bản TS).
pub fn fold_contains(q: &str) -> String {
    format!("%{}%", escape_like(&fold_vi(trim_js(q))))
}

/// `String.prototype.trim` của JS: bỏ khoảng trắng và ký tự kết thúc dòng theo định nghĩa ECMAScript ở hai đầu.
pub fn trim_js(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// Ký tự khớp `\s` của biểu thức chính quy JS (WhiteSpace + LineTerminator của ECMAScript).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Kiểu so sánh chuỗi, ứng với các cách gọi `localeCompare` của bản TS. Danh sách chỗ dùng và quyết định từng chỗ
/// (sắp ở DB hay bằng hàm này): `docs/rust/locale-vi.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Collation {
    /// `a.localeCompare(b, 'vi')`: thứ tự chữ cái tiếng Việt (a < ă < â, d < đ, dấu thanh ở mức phụ).
    Vi,
    /// `a.localeCompare(b, 'en', { numeric: true })`: dãy chữ số so theo giá trị (`KH-2` < `KH-10`).
    EnNumeric,
    /// `a.localeCompare(b)` không truyền locale: locale mặc định của tiến trình Node (en-US) = thứ tự gốc CLDR.
    Root,
}

fn collator(prefs: CollatorPreferences) -> CollatorBorrowed<'static> {
    // Dữ liệu biên dịch sẵn (compiled_data) luôn có các locale này: lỗi ở đây là lỗi build, không phải lỗi lúc chạy.
    Collator::try_new(prefs, CollatorOptions::default()).expect("collator ICU4X dữ liệu biên dịch sẵn")
}

static VI: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(locale!("vi").into()));
static EN_NUMERIC: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let mut prefs: CollatorPreferences = locale!("en").into();
    prefs.numeric_ordering = Some(CollationNumericOrdering::True);
    collator(prefs)
});
static ROOT: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| collator(locale!("en").into()));

/// So sánh hai chuỗi như `localeCompare` của V8 (ICU) với kiểu [`Collation`] tương ứng.
pub fn compare(a: &str, b: &str, collation: Collation) -> Ordering {
    match collation {
        Collation::Vi => VI.compare(a, b),
        Collation::EnNumeric => EN_NUMERIC.compare(a, b),
        Collation::Root => ROOT.compare(a, b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bang_translate_khop_fold_vi() {
        let to: String = SQL_FOLD_FROM.chars().map(|c| fold_vi(&c.to_string())).collect();
        assert_eq!(to, SQL_FOLD_TO);
        assert_eq!(SQL_FOLD_FROM.chars().count(), SQL_FOLD_TO.chars().count());
    }

    #[test]
    #[should_panic(expected = "định danh SQL")]
    fn sql_ident_tu_choi_chuoi_la() {
        let _ = SqlIdent::new("name; DROP TABLE x");
    }

    #[test]
    fn fold_sql_dung_hinh_dang() {
        const COL: SqlIdent = SqlIdent::new("c.full_name");
        assert_eq!(fold_sql(COL, 1, 2), "translate(lower(c.full_name), $1, $2)");
        assert_eq!(SqlIdent::new("title").as_str(), "title");
    }
}
