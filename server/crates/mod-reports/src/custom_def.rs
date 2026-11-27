//! Định nghĩa báo cáo dùng chung (`reports/custom/report-def.ts`): chọn bảng nguồn, trường ngày chia kỳ, cột cộng tổng, trường
//! nhóm. Lưu một khoá JSON trong `settings` (`report.definitions`). Chỉ kiểm HÌNH DẠNG ở đây; trường có thật trong bảng không là
//! việc của module này mà của service ([`crate::custom`]).

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use trinity_kernel::vi::trim_js;
use trinity_kernel::vn_time::vn_date;

pub const REPORT_DEFS_KEY: &str = "report.definitions";
pub const MAX_REPORTS: usize = 50;
pub const MAX_SUMS: usize = 4;
pub const MAX_NAME: usize = 80;
pub const MAX_GROUPS: i64 = 50;
pub const MAX_MONTHS: i64 = 24;

/// Đường con của `reports/custom/*`, không dùng làm mã báo cáo.
const RESERVED_IDS: [&str; 3] = ["sources", "definitions", "presets"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportDef {
    pub id: String,
    pub name: String,
    /// `contacts` · `deals` · `x:<khoá bảng tuỳ biến>`.
    pub source: String,
    pub date_field: String,
    pub sum_fields: Vec<String>,
    pub group_by: Option<String>,
    pub preset: Option<String>,
}

impl ReportDef {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("name".into(), json!(self.name));
        m.insert("source".into(), json!(self.source));
        m.insert("date_field".into(), json!(self.date_field));
        m.insert("sum_fields".into(), json!(self.sum_fields));
        m.insert("group_by".into(), json!(self.group_by));
        if let Some(p) = &self.preset {
            m.insert("preset".into(), json!(p));
        }
        Value::Object(m)
    }
}

/// Lỗi hình dạng (câu tiếng Việt, đổi thành 400).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefError(pub String);

fn err<T>(m: impl Into<String>) -> Result<T, DefError> {
    Err(DefError(m.into()))
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `^[a-z][a-z0-9_]{0,47}$`.
fn id_like(s: &str) -> bool {
    let mut it = s.chars();
    it.next().is_some_and(|c| c.is_ascii_lowercase())
        && s.len() <= 48
        && it.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn source_ok(s: &str) -> bool {
    s == "contacts" || s == "deals" || s.strip_prefix("x:").is_some_and(id_like)
}

fn text(v: Option<&Value>, what: &str, max: usize) -> Result<String, DefError> {
    match v {
        Some(Value::String(s)) if !trim_js(s).is_empty() => {
            let s = trim_js(s);
            if js_len(s) > max {
                return err(format!("{what} tối đa {max} ký tự"));
            }
            Ok(s.to_owned())
        }
        _ => err(format!("{what} không được trống")),
    }
}

fn field_key(v: Option<&Value>, what: &str) -> Result<String, DefError> {
    let s = text(v, what, 48)?;
    if !id_like(&s) {
        return err(format!("{what} “{}” không hợp lệ", head(&s, 30)));
    }
    Ok(s)
}

/// `normalizeReportDefs`: kiểm HÌNH DẠNG danh sách định nghĩa.
pub fn normalize_defs(raw: &Value) -> Result<Vec<ReportDef>, DefError> {
    let Some(list) = raw.as_array() else {
        return err("Danh sách báo cáo phải là mảng");
    };
    if list.len() > MAX_REPORTS {
        return err(format!("Tối đa {MAX_REPORTS} báo cáo"));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (i, r) in list.iter().enumerate() {
        // Như JS: mảng cũng là object (không có khoá nào ⇒ lỗi "không được trống" ở bước đầu).
        let o = match r {
            Value::Object(o) => o.clone(),
            Value::Array(_) => Map::new(),
            _ => return err(format!("Báo cáo #{} không hợp lệ", i + 1)),
        };
        let id = text(o.get("id"), "Mã báo cáo", 48)?;
        if !id_like(&id) {
            return err(format!("Mã báo cáo “{}” chỉ gồm a-z, 0-9, _", head(&id, 30)));
        }
        if RESERVED_IDS.contains(&id.as_str()) {
            return err(format!("Mã báo cáo “{id}” trùng tên đường dẫn hệ thống"));
        }
        if seen.contains(&id) {
            return err(format!("Trùng mã báo cáo “{id}”"));
        }
        seen.push(id.clone());
        let name = text(o.get("name"), "Tên báo cáo", MAX_NAME)?;
        let source = text(o.get("source"), "Bảng nguồn", 50)?;
        if !source_ok(&source) {
            return err(format!("Bảng nguồn “{}” không hợp lệ", head(&source, 30)));
        }
        let sums_raw = match o.get("sum_fields") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.clone(),
            Some(_) => return err("Cột cộng tổng phải là danh sách"),
        };
        if sums_raw.len() > MAX_SUMS {
            return err(format!("Tối đa {MAX_SUMS} cột cộng tổng"));
        }
        let date_field = field_key(o.get("date_field"), "Trường ngày")?;
        let mut sum_fields: Vec<String> = Vec::new();
        for s in &sums_raw {
            let k = field_key(Some(s), "Cột cộng tổng")?;
            if !sum_fields.contains(&k) {
                sum_fields.push(k);
            }
        }
        let group_by = match o.get("group_by") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            other => Some(field_key(other, "Trường nhóm")?),
        };
        let preset = o
            .get("preset")
            .and_then(Value::as_str)
            .filter(|p| id_like(p))
            .map(str::to_owned);
        out.push(ReportDef {
            id,
            name,
            source,
            date_field,
            sum_fields,
            group_by,
            preset,
        });
    }
    Ok(out)
}

/// Kỳ báo cáo: `this_month` · `month:YYYY-MM` · `year:YYYY` · `all`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Period {
    All,
    /// `to` là ngày ĐẦU kỳ sau (khoảng nửa mở).
    Range {
        from: String,
        to: String,
        label: String,
    },
}

fn month_range(y: i64, mo: i64) -> Period {
    let (ny, nm) = if mo == 12 { (y + 1, 1) } else { (y, mo + 1) };
    Period::Range {
        from: format!("{y}-{mo:02}-01"),
        to: format!("{ny}-{nm:02}-01"),
        label: format!("Tháng {mo}/{y}"),
    }
}

fn digits(s: &str, n: usize) -> Option<i64> {
    (s.len() == n && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `parseReportPeriod`: đọc kỳ từ query; sai dạng thì về "Tháng này".
pub fn parse_period(raw: Option<&str>, now: DateTime<Utc>) -> Period {
    let v = trim_js(raw.unwrap_or("this_month"));
    if v == "all" {
        return Period::All;
    }
    if let Some((y, m)) = v
        .strip_prefix("month:")
        .and_then(|r| r.split_once('-'))
        .and_then(|(y, m)| Some((digits(y, 4)?, digits(m, 2)?)))
        && (1..=12).contains(&m)
    {
        return month_range(y, m);
    }
    if let Some(y) = v.strip_prefix("year:").and_then(|y| digits(y, 4))
        && (1900..=2200).contains(&y)
    {
        return Period::Range {
            from: format!("{y}-01-01"),
            to: format!("{}-01-01", y + 1),
            label: format!("Năm {y}"),
        };
    }
    let today = vn_date(now);
    month_range(
        i64::from(chrono::Datelike::year(&today)),
        i64::from(chrono::Datelike::month(&today)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn msg(v: Value) -> String {
        normalize_defs(&v).unwrap_err().0
    }

    #[test]
    fn hinh_dang_dinh_nghia() {
        let ok = normalize_defs(&json!([{ "id": "a", "name": " Tên ", "source": "x:hoc_sinh", "date_field": "created_at", "sum_fields": ["so_tien", "so_tien"], "group_by": "", "preset": "giao_duc", "la": 1 }])).unwrap();
        assert_eq!(
            ok[0].to_json(),
            json!({ "id": "a", "name": "Tên", "source": "x:hoc_sinh", "date_field": "created_at", "sum_fields": ["so_tien"], "group_by": null, "preset": "giao_duc" })
        );
        assert_eq!(msg(json!("x")), "Danh sách báo cáo phải là mảng");
        assert_eq!(msg(json!([1])), "Báo cáo #1 không hợp lệ");
        assert_eq!(msg(json!([{}])), "Mã báo cáo không được trống");
        assert_eq!(msg(json!([{ "id": "A" }])), "Mã báo cáo “A” chỉ gồm a-z, 0-9, _");
        assert_eq!(
            msg(json!([{ "id": "sources" }])),
            "Mã báo cáo “sources” trùng tên đường dẫn hệ thống"
        );
        let d = json!({ "id": "a", "name": "n", "source": "contacts", "date_field": "created_at" });
        assert_eq!(msg(json!([d, d])), "Trùng mã báo cáo “a”");
        assert_eq!(
            msg(json!([{ "id": "a", "name": "n", "source": "tables" }])),
            "Bảng nguồn “tables” không hợp lệ"
        );
        assert_eq!(
            msg(json!([{ "id": "a", "name": "n", "source": "deals", "sum_fields": "x" }])),
            "Cột cộng tổng phải là danh sách"
        );
        assert_eq!(
            msg(json!([{ "id": "a", "name": "n", "source": "deals", "sum_fields": [1, 2, 3, 4, 5] }])),
            "Tối đa 4 cột cộng tổng"
        );
        assert_eq!(
            msg(json!([{ "id": "a", "name": "n", "source": "deals", "date_field": "Ngay" }])),
            "Trường ngày “Ngay” không hợp lệ"
        );
        assert_eq!(
            msg(json!([{ "id": "a", "name": "x".repeat(81), "source": "deals", "date_field": "d" }])),
            "Tên báo cáo tối đa 80 ký tự"
        );
        assert!(msg(Value::Array((0..51).map(|_| json!({})).collect())).contains("Tối đa 50 báo cáo"));
        // preset sai dạng bị bỏ im lặng; group_by null giữ null.
        let p = normalize_defs(
            &json!([{ "id": "a", "name": "n", "source": "deals", "date_field": "d", "preset": "Sai!" }]),
        )
        .unwrap();
        assert_eq!((p[0].preset.clone(), p[0].group_by.clone()), (None, None));
    }

    #[test]
    fn ky_bao_cao() {
        let now = at("2026-11-27T10:00:00Z");
        let r = |s: Option<&str>| parse_period(s, now);
        assert_eq!(r(Some("all")), Period::All);
        assert_eq!(
            r(Some("month:2026-02")),
            Period::Range {
                from: "2026-02-01".into(),
                to: "2026-03-01".into(),
                label: "Tháng 2/2026".into()
            }
        );
        assert_eq!(
            r(Some("month:2026-12")),
            Period::Range {
                from: "2026-12-01".into(),
                to: "2027-01-01".into(),
                label: "Tháng 12/2026".into()
            }
        );
        assert_eq!(
            r(Some("year:2026")),
            Period::Range {
                from: "2026-01-01".into(),
                to: "2027-01-01".into(),
                label: "Năm 2026".into()
            }
        );
        // Sai dạng / ngoài khoảng ⇒ tháng này (giờ VN).
        let this = Period::Range {
            from: "2026-11-01".into(),
            to: "2026-12-01".into(),
            label: "Tháng 11/2026".into(),
        };
        for bad in [None, Some("month:2026-13"), Some("year:1800"), Some("x"), Some("")] {
            assert_eq!(r(bad), this, "{bad:?}");
        }
        // 17:30 UTC ngày cuối tháng đã là ngày 1 giờ VN.
        assert_eq!(
            parse_period(None, at("2026-11-30T17:30:00Z")),
            Period::Range {
                from: "2026-12-01".into(),
                to: "2027-01-01".into(),
                label: "Tháng 12/2026".into()
            }
        );
    }
}
