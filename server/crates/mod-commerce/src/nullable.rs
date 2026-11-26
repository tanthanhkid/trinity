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
