//! Kiểu cột dùng trong struct model sinh tự động ([`crate::models`]): đọc bằng sqlx, ghi JSON đúng chữ bản Node
//! (`JSON.stringify` sau khi Prisma đọc), theo [`trinity_kernel::json`].
//!
//! | Prisma | Postgres | Kiểu Rust | JSON |
//! |---|---|---|---|
//! | `DateTime` (`@db.Timestamptz`) | `timestamptz` | [`Timestamp`] | `"2026-03-05T07:30:09.000Z"` (cắt còn mili giây) |
//! | `DateTime` (`@db.Timestamp`, không `@db`) | `timestamp` | [`NaiveTimestamp`] | như trên, giờ trong DB coi là UTC (như Prisma) |
//! | `DateTime @db.Date` | `date` | [`DbDate`] | `"2026-03-05T00:00:00.000Z"` |
//! | `Decimal` | `numeric` | [`DecimalJs`] | chuỗi kiểu decimal.js (`"12.5"`) |
//! | `BigInt` | `int8` | [`JsBigInt`] | số JSON (`Number(v)`, mất chính xác trên 2^53 như Node) |
//! | `Float` | `float8` | [`JsNumber`] | số JSON kiểu JS (`1`, `1e+21`) |
//! | `Json` | `jsonb` | [`JsonValue`] | như `JSON.stringify(JSON.parse(text))`; số ngoài f64 → `null` |
//! | `T[]` | `_T` | [`PgList`] | mảng; NULL → `[]` như Prisma |

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use sqlx::error::BoxDynError;
use sqlx::postgres::{PgTypeInfo, PgValueFormat, PgValueRef};
use sqlx::{Postgres, TypeInfo, ValueRef};
use trinity_kernel::json::{decimal_js, js_json, js_number};
use trinity_kernel::vn_time::js_iso_string;

/// Ghi một đoạn JSON đã định dạng sẵn (chỉ đúng với serializer của serde_json, là serializer của API).
fn raw<S: Serializer>(text: String, s: S) -> Result<S::Ok, S::Error> {
    let raw = RawValue::from_string(text).map_err(serde::ser::Error::custom)?;
    raw.serialize(s)
}

/// `timestamptz`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, sqlx::Type)]
#[sqlx(transparent)]
pub struct Timestamp(pub DateTime<Utc>);

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&js_iso_string(self.0))
    }
}

/// `timestamp` không múi giờ (`contacts.deleted_at`, `login_wifi_check_targets.created_at`): Prisma coi giá trị là UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, sqlx::Type)]
#[sqlx(transparent)]
pub struct NaiveTimestamp(pub NaiveDateTime);

impl Serialize for NaiveTimestamp {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&js_iso_string(self.0.and_utc()))
    }
}

/// `date` (`@db.Date`): Prisma trả nửa đêm UTC của ngày đó.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, sqlx::Type)]
#[sqlx(transparent)]
pub struct DbDate(pub NaiveDate);

impl Serialize for DbDate {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&js_iso_string(self.0.and_time(chrono::NaiveTime::MIN).and_utc()))
    }
}

/// `numeric` (`Decimal` của Prisma).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, sqlx::Type)]
#[sqlx(transparent)]
pub struct DecimalJs(pub Decimal);

impl Serialize for DecimalJs {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&decimal_js(self.0.mantissa(), self.0.scale()))
    }
}

/// Số JSON lớn hơn 2^53 thì JS in dạng số thực; dưới ngưỡng này chữ của số nguyên giống nhau.
const SAFE_INT: i64 = 1 << 53;

/// `int8` (`BigInt`): ra JSON là `Number(v)` như `BigInt.prototype.toJSON` của bản Node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, sqlx::Type)]
#[sqlx(transparent)]
pub struct JsBigInt(pub i64);

impl Serialize for JsBigInt {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if (-SAFE_INT..=SAFE_INT).contains(&self.0) {
            s.serialize_i64(self.0)
        } else {
            // i64 → f64 làm tròn về số gần nhất, như `Number(bigint)`.
            raw(js_number(self.0 as f64), s)
        }
    }
}

/// `float8` (`Float`).
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, sqlx::Type)]
#[sqlx(transparent)]
pub struct JsNumber(pub f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        raw(js_number(self.0), s)
    }
}

/// `jsonb` / `json` (`Json`).
///
/// Đọc từ chữ JSON của Postgres bằng đường số khoan dung: số ngoài khoảng f64 (`1e999`) thành `null` như
/// `JSON.parse` + `JSON.stringify` của Node (`Infinity` → `null`), thay vì làm hỏng cả dòng.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonValue(pub serde_json::Value);

impl Serialize for JsonValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        raw(js_json(&self.0), s)
    }
}

impl sqlx::Type<Postgres> for JsonValue {
    fn type_info() -> PgTypeInfo {
        PgTypeInfo::with_name("jsonb")
    }

    fn compatible(ty: &PgTypeInfo) -> bool {
        *ty == PgTypeInfo::with_name("jsonb") || *ty == PgTypeInfo::with_name("json")
    }
}

impl<'r> sqlx::Decode<'r, Postgres> for JsonValue {
    fn decode(value: PgValueRef<'r>) -> Result<Self, BoxDynError> {
        let bytes = value.as_bytes()?;
        // jsonb nhị phân: byte đầu là số phiên bản (1), phần sau là chữ JSON.
        let is_jsonb = value.type_info().name().eq_ignore_ascii_case("jsonb");
        let bytes = if value.format() == PgValueFormat::Binary && is_jsonb {
            bytes.get(1..).ok_or("jsonb rỗng")?
        } else {
            bytes
        };
        parse_lenient(std::str::from_utf8(bytes)?).map(Self)
    }
}

/// Đọc chữ JSON, số mà f64 không biểu diễn được (vô cực) thành `null`.
pub fn parse_lenient(text: &str) -> Result<serde_json::Value, BoxDynError> {
    match serde_json::from_str(text) {
        Ok(v) => Ok(v),
        Err(first) => {
            let fixed = null_out_of_range_numbers(text);
            serde_json::from_str(&fixed).map_err(|_| first.into())
        }
    }
}

/// Thay mọi số có f64 vô cực bằng `null`, bỏ qua nội dung chuỗi.
fn null_out_of_range_numbers(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut start) = (0, 0);
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let s = i;
                while i < b.len() && matches!(b[i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    i += 1;
                }
                if text[s..i].parse::<f64>().is_ok_and(f64::is_infinite) {
                    out.push_str(&text[start..s]);
                    out.push_str("null");
                    start = i;
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&text[start.min(text.len())..]);
    out
}

/// Cột mảng (`String[]`, `Int[]`): Prisma tạo cột không NOT NULL và đọc NULL thành `[]`, JSON ra `[]`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(transparent)]
pub struct PgList<T>(pub Vec<T>);

impl<T> sqlx::Type<Postgres> for PgList<T>
where
    Vec<T>: sqlx::Type<Postgres>,
{
    fn type_info() -> PgTypeInfo {
        <Vec<T> as sqlx::Type<Postgres>>::type_info()
    }

    fn compatible(ty: &PgTypeInfo) -> bool {
        <Vec<T> as sqlx::Type<Postgres>>::compatible(ty)
    }
}

impl<'r, T> sqlx::Decode<'r, Postgres> for PgList<T>
where
    Vec<T>: sqlx::Decode<'r, Postgres>,
{
    fn decode(value: PgValueRef<'r>) -> Result<Self, BoxDynError> {
        if value.is_null() {
            return Ok(Self(Vec::new()));
        }
        <Vec<T> as sqlx::Decode<Postgres>>::decode(value).map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(text: &str) -> String {
        serde_json::to_string(&JsonValue(parse_lenient(text).expect("đọc"))).expect("ghi")
    }

    #[test]
    fn so_ngoai_khoang_f64_thanh_null_khong_loi_ca_dong() {
        // Prisma/Node báo lỗi cả dòng với số này; Rust đọc được và ra `null` (như `Infinity` qua JSON.stringify).
        assert_eq!(
            out(r#"[1e999, {"a": -1e999, "b": 2e400, "c": 1, "d": 1.0}, "1e999", 1E+999]"#),
            r#"[null,{"a":null,"b":null,"c":1,"d":1},"1e999",null]"#
        );
        assert_eq!(out(r#"{"s": "a\"1e999", "n": -1e-999}"#), r#"{"s":"a\"1e999","n":0}"#);
    }

    #[test]
    fn so_thuc_giu_du_chu_so() {
        assert_eq!(
            out("[106.66009616851807, 0.30000000000000004]"),
            "[106.66009616851807,0.30000000000000004]"
        );
    }

    #[test]
    fn json_hong_van_bao_loi() {
        assert!(parse_lenient("[1e999,").is_err());
    }
}
