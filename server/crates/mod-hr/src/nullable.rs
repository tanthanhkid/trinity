//! `Option<Option<T>>` cho trường PATCH: không có khoá = `None` (giữ nguyên), `null` = `Some(None)` (xoá giá trị).

use serde::Deserialize;

/// `#[serde(default, deserialize_with = "some_nullable")]`.
pub fn some_nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Như [`some_nullable`] nhưng giữ nguyên giá trị JSON thô (kể cả `null`), để `validate()` báo lỗi kiểu như class-validator.
pub fn some_value<'de, D>(d: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    serde_json::Value::deserialize(d).map(Some)
}

/// Số nguyên từ JSON: số, hoặc chuỗi số như `@Type(() => Number)` của class-transformer.
fn int_of(v: &serde_json::Value) -> Option<i64> {
    let f = crate::js_number(v)?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    (f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0).then_some(f as i64)
}

/// `#[serde(default, deserialize_with = "lenient_i64_opt")]`: vắng/`null` = `None`; số hoặc chuỗi số nguyên.
pub fn lenient_i64_opt<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    if v.is_null() {
        return Ok(None);
    }
    int_of(&v)
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("phải là số nguyên"))
}

/// Số nguyên i32 bắt buộc, nhận số hoặc chuỗi số.
pub fn lenient_i32<'de, D>(d: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    int_of(&v)
        .and_then(|n| i32::try_from(n).ok())
        .ok_or_else(|| serde::de::Error::custom("phải là số nguyên"))
}

/// Như [`lenient_i32`] nhưng tuỳ chọn (vắng/`null` = `None`).
pub fn lenient_i32_opt<'de, D>(d: D) -> Result<Option<i32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    if v.is_null() {
        return Ok(None);
    }
    int_of(&v)
        .and_then(|n| i32::try_from(n).ok())
        .map(Some)
        .ok_or_else(|| serde::de::Error::custom("phải là số nguyên"))
}
