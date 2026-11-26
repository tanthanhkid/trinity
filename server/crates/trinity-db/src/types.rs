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
//! | `Json` | `jsonb` | [`JsonValue`] | như `JSON.stringify(JSON.parse(text))` |

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rust_decimal::Decimal;
use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
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

/// `jsonb` (`Json`).
#[derive(Debug, Clone, PartialEq, sqlx::Type)]
#[sqlx(transparent)]
pub struct JsonValue(pub serde_json::Value);

impl Serialize for JsonValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        raw(js_json(&self.0), s)
    }
}
