//! Kiểu trường, giới hạn, biểu tượng và `FieldDef` (chuyển từ `field-types.ts`).

use serde::Serialize;
use serde_json::{Map, Value};
use trinity_db::models::CustomField;

pub const FIELD_TYPES: [&str; 17] = [
    "text",
    "long_text",
    "number",
    "currency",
    "percent",
    "date",
    "datetime",
    "boolean",
    "select",
    "multi_select",
    "email",
    "phone",
    "url",
    "relation",
    "user",
    "formula",
    "link",
];

pub fn is_field_type(t: &str) -> bool {
    FIELD_TYPES.contains(&t)
}

pub const TITLE_TYPES: [&str; 4] = ["text", "number", "email", "date"];
pub const NUMERIC_TYPES: [&str; 3] = ["number", "currency", "percent"];
pub const DATE_TYPES: [&str; 2] = ["date", "datetime"];
pub const FILTERABLE_TYPES: [&str; 10] = [
    "select",
    "multi_select",
    "number",
    "currency",
    "percent",
    "date",
    "datetime",
    "boolean",
    "relation",
    "user",
];
pub const SORTABLE_TYPES: [&str; 7] = ["text", "number", "currency", "percent", "date", "datetime", "select"];
pub const UNIQUE_TYPES: [&str; 7] = ["text", "number", "currency", "email", "url", "date", "datetime"];
pub const COMPATIBLE_TYPE_GROUPS: [[&str; 2]; 1] = [["text", "long_text"]];

pub struct Limits;

impl Limits {
    pub const MAX_OBJECTS: i64 = 50;
    pub const MAX_FIELDS_PER_OBJECT: usize = 60;
    pub const MAX_CHOICES: usize = 100;
    pub const MAX_TEXT: usize = 500;
    pub const MAX_TITLE: i32 = 200;
    pub const MAX_FILTER_KEYS: usize = 10;
    pub const MAX_FILTER_VALUES: usize = 50;
    pub const LOOKUP_LIMIT: i64 = 20;
    pub const MAX_MULTI_VALUES: usize = 50;
    pub const MAX_RELATION_VALUES: usize = 50;
    pub const MAX_LINK_VALUES: usize = 50;
    pub const MAX_DATA_BYTES: usize = 32 * 1024;
    pub const MAX_LONG_TEXT: usize = 10_000;
    pub const MAX_URL: usize = 2_000;
    pub const MAX_NUMBER: f64 = 1e15;
    pub const MAX_CURRENCY: f64 = 1e13;
    pub const MAX_LIST_LIMIT: i64 = 100;
    pub const DEFAULT_LIST_LIMIT: i64 = 30;
    pub const EXPORT_ROW_CAP: i64 = 20_000;
    pub const RELATED_PER_GROUP: i64 = 20;
    pub const MAX_RELATED_GROUPS: i64 = 20;
}

pub const RESERVED_OBJECT_KEYS: [&str; 6] = ["nav", "templates", "lookup", "formula", "new", "export"];

pub const CUSTOM_ICONS: [&str; 32] = [
    "shapes",
    "users",
    "user-round",
    "graduation-cap",
    "book-open",
    "receipt",
    "wallet",
    "clipboard-list",
    "calendar-check",
    "package",
    "store",
    "building-2",
    "briefcase",
    "heart-pulse",
    "stethoscope",
    "car",
    "home",
    "wrench",
    "truck",
    "shopping-cart",
    "file-text",
    "folder",
    "tag",
    "star",
    "map-pin",
    "phone",
    "credit-card",
    "banknote",
    "baby",
    "utensils",
    "dumbbell",
    "plane",
];

pub const CHOICE_COLORS: [&str; 10] = [
    "gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink",
];

/// `^[a-z][a-z0-9_]{0,47}$`.
pub fn valid_key(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 48
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// Độ dài theo đơn vị UTF-16 như `String.length` của JS.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Trường đã chuẩn hoá (thứ tự khoá như `FieldDef` của bản TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldDef {
    pub id: i32,
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub required: bool,
    pub is_unique: bool,
    pub is_title: bool,
    pub show_in_list: bool,
    pub sort_order: i32,
    pub options: Value,
    pub help_text: Option<String>,
}

impl FieldDef {
    /// `toFieldDef`: kiểu lạ ⇒ `text`; `options` không phải object ⇒ `{}`.
    pub fn from_row(r: &CustomField) -> Self {
        Self {
            id: r.id,
            key: r.key.clone(),
            label: r.label.clone(),
            kind: if is_field_type(&r.r#type) {
                r.r#type.clone()
            } else {
                "text".to_owned()
            },
            required: r.required,
            is_unique: r.is_unique,
            is_title: r.is_title,
            show_in_list: r.show_in_list,
            sort_order: r.sort_order,
            options: if r.options.0.is_object() {
                r.options.0.clone()
            } else {
                Value::Object(Map::new())
            },
            help_text: r.help_text.clone(),
        }
    }
}
