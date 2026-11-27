//! Kiểm body của các DTO commerce mà `contracts/dto/schema.json` không có (các lớp `PartialType` và DTO danh mục/thuộc tính),
//! theo đúng luật class-validator của bản TS ở chế độ strict: trường lạ ⇒ "property x should not exist" (đứng đầu), rồi từng
//! trường theo thứ tự khai báo; mỗi trường báo theo thứ tự decorator từ dưới lên. `null` ở cột NOT NULL ⇒ 400.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::de::DeserializeOwned;
use serde_json::{Map, Number, Value};
use trinity_http::validate::Dto;
use trinity_kernel::error::HttpError;

use crate::attribute_defs::{CreateAttributeDef, UpdateAttributeDef};
use crate::attributes::ATTRIBUTE_TYPES;
use crate::categories::{CreateCategory, UpdateCategory};
use crate::products::{CreateProduct, ListProducts, UpdateProduct};
use crate::projects::{CreateProject, UpdateProject};

impl Dto for CreateProduct {
    const NAME: &'static str = "CreateProductDto";
}

impl Dto for ListProducts {
    const NAME: &'static str = "ListProductsQueryDto";
}

const INT4_MAX: f64 = 2_147_483_647.0;

/// Độ dài như `String.length` của JS (đơn vị UTF-16).
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `Number.isInteger` của JS: số nguyên (kể cả dạng `3.0`).
fn int_of(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.fract() == 0.0)
}

type StrPattern = (fn(&str) -> bool, &'static str);

struct Str {
    min: Option<(usize, &'static str)>,
    max: Option<(usize, &'static str)>,
    pat: Option<StrPattern>,
    is: &'static str,
}

/// Thứ tự thông báo: `@Matches`, `@MaxLength`, `@MinLength`, `@IsString` (decorator dưới cùng báo trước).
fn check_str(v: Option<&Value>, r: &Str, out: &mut Vec<String>) {
    let s = v.and_then(Value::as_str);
    if let Some((f, m)) = r.pat
        && !s.is_some_and(f)
    {
        out.push(m.to_owned());
    }
    if let Some((n, m)) = r.max
        && !s.is_some_and(|s| len16(s) <= n)
    {
        out.push(m.to_owned());
    }
    if let Some((n, m)) = r.min
        && !s.is_some_and(|s| len16(s) >= n)
    {
        out.push(m.to_owned());
    }
    if s.is_none() {
        out.push(r.is.to_owned());
    }
}

struct Int {
    min: (f64, &'static str),
    max: (f64, &'static str),
    is: &'static str,
}

/// Thứ tự: `@Max`, `@Min`, `@IsInt`.
fn check_int(v: Option<&Value>, r: &Int, out: &mut Vec<String>) {
    let n = v.and_then(int_of);
    if !n.is_some_and(|n| n <= r.max.0) {
        out.push(r.max.1.to_owned());
    }
    if !n.is_some_and(|n| n >= r.min.0) {
        out.push(r.min.1.to_owned());
    }
    if n.is_none() {
        out.push(r.is.to_owned());
    }
}

fn check_bool(v: Option<&Value>, msg: &str, out: &mut Vec<String>) {
    if !matches!(v, Some(Value::Bool(_))) {
        out.push(msg.to_owned());
    }
}

/// Body như `ValidationPipe` thấy: mảng ⇒ khoá là chỉ số (strict báo "property 0 should not exist"), không phải object ⇒ `{}`.
fn as_obj(v: &Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m.clone(),
        Value::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        _ => Map::new(),
    }
}

fn unknown(o: &Map<String, Value>, allowed: &[&str], out: &mut Vec<String>) {
    for k in o.keys().filter(|k| !allowed.contains(&k.as_str())) {
        out.push(format!("property {k} should not exist"));
    }
}

/// `@ValidateIf(isDefined)` / `PartialType`: có khoá (kể cả `null`) thì mới kiểm.
fn defined<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    o.get(k)
}

/// `@IsOptional()`: vắng hoặc `null` thì bỏ qua.
fn optional<'a>(o: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    o.get(k).filter(|v| !v.is_null())
}

/// Số nguyên dạng `3.0` về `3` để serde đọc được vào `i32`.
fn normalize_ints(o: &mut Map<String, Value>, keys: &[&str]) {
    for k in keys {
        if let Some(Value::Number(n)) = o.get(*k)
            && n.as_i64().is_none()
            && let Some(f) = n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
        {
            o.insert((*k).to_owned(), Value::Number(Number::from(f as i64)));
        }
    }
}

fn finish<T: DeserializeOwned>(errors: Vec<String>, o: Map<String, Value>) -> Result<T, HttpError> {
    if !errors.is_empty() {
        return Err(HttpError::validation(errors));
    }
    serde_json::from_value(Value::Object(o)).map_err(|_| HttpError::bad_request("Bad Request"))
}

fn code_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn key_ok(s: &str) -> bool {
    let mut it = s.bytes();
    let first = it.next().is_some_and(|b| b.is_ascii_lowercase());
    first && it.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn id_rules(min: &'static str, max: &'static str, is: &'static str) -> Int {
    Int {
        min: (1.0, min),
        max: (INT4_MAX, max),
        is,
    }
}

fn sort_order(o: &Map<String, Value>, out: &mut Vec<String>) {
    if let Some(x) = defined(o, "sort_order") {
        let r = Int {
            min: (0.0, "sort_order không được âm"),
            max: (INT4_MAX, "sort_order vượt giới hạn số nguyên 32-bit"),
            is: "sort_order phải là số nguyên",
        };
        check_int(Some(x), &r, out);
    }
}

fn tags_errors(x: &Value, out: &mut Vec<String>) {
    let arr = x.as_array();
    if arr.is_none_or(|a| a.iter().any(|t| !t.as_str().is_some_and(|s| len16(s) <= 255))) {
        out.push("mỗi tag tối đa 255 ký tự".to_owned());
    }
    if arr.is_none_or(|a| a.iter().any(|t| !t.is_string())) {
        out.push("tags chỉ chứa chuỗi".to_owned());
    }
    if arr.is_none_or(|a| a.len() > 30) {
        out.push("tags tối đa 30 phần tử".to_owned());
    }
    if arr.is_none() {
        out.push("tags phải là mảng".to_owned());
    }
}

/// `UpdateProductDto` = `CreateProductDto` bỏ `code`, `project_id`, mọi trường tuỳ chọn, thêm `is_active`.
pub fn update_product(body: &Value) -> Result<UpdateProduct, HttpError> {
    let mut o = as_obj(body);
    let mut e = Vec::new();
    let allowed = [
        "name",
        "category_id",
        "attributes",
        "description",
        "price",
        "brand",
        "color",
        "tags",
        "is_featured",
        "image_url",
        "is_active",
    ];
    unknown(&o, &allowed, &mut e);
    if let Some(x) = defined(&o, "name") {
        let r = Str {
            min: Some((2, "Tên sản phẩm tối thiểu 2 ký tự")),
            max: Some((255, "Tên sản phẩm tối đa 255 ký tự")),
            pat: None,
            is: "name phải là chuỗi",
        };
        check_str(Some(x), &r, &mut e);
    }
    if let Some(x) = optional(&o, "category_id") {
        let r = id_rules(
            "category_id không hợp lệ",
            "category_id vượt giới hạn số nguyên 32-bit",
            "category_id phải là số nguyên",
        );
        check_int(Some(x), &r, &mut e);
    }
    if let Some(x) = optional(&o, "attributes")
        && !x.is_object()
    {
        e.push("attributes phải là object".to_owned());
    }
    if let Some(x) = optional(&o, "description") {
        let r = Str {
            min: None,
            max: Some((2000, "description tối đa 2000 ký tự")),
            pat: None,
            is: "description phải là chuỗi",
        };
        check_str(Some(x), &r, &mut e);
    }
    if let Some(x) = optional(&o, "price") {
        let r = Int {
            min: (0.0, "price không được âm"),
            max: (1_000_000_000_000.0, "price vượt trần cho phép"),
            is: "price phải là số nguyên",
        };
        check_int(Some(x), &r, &mut e);
    }
    if let Some(x) = optional(&o, "brand") {
        let r = Str {
            min: None,
            max: Some((255, "brand tối đa 255 ký tự")),
            pat: None,
            is: "brand phải là chuỗi",
        };
        check_str(Some(x), &r, &mut e);
    }
    if let Some(x) = optional(&o, "color") {
        let r = Str {
            min: None,
            max: Some((32, "color tối đa 32 ký tự")),
            pat: None,
            is: "color phải là chuỗi",
        };
        check_str(Some(x), &r, &mut e);
    }
    if let Some(x) = defined(&o, "tags") {
        tags_errors(x, &mut e);
    }
    if let Some(x) = defined(&o, "is_featured") {
        check_bool(Some(x), "is_featured phải là boolean", &mut e);
    }
    if let Some(x) = optional(&o, "image_url") {
        let r = Str {
            min: None,
            max: Some((2048, "image_url tối đa 2048 ký tự")),
            pat: None,
            is: "image_url phải là chuỗi",
        };
        check_str(Some(x), &r, &mut e);
    }
    if let Some(x) = defined(&o, "is_active") {
        check_bool(Some(x), "is_active phải là boolean", &mut e);
    }
    normalize_ints(&mut o, &["category_id"]);
    finish(e, o)
}

fn category_name(v: Option<&Value>, out: &mut Vec<String>) {
    let r = Str {
        min: Some((2, "Tên danh mục tối thiểu 2 ký tự")),
        max: Some((255, "Tên danh mục tối đa 255 ký tự")),
        pat: None,
        is: "name phải là chuỗi",
    };
    check_str(v, &r, out);
}

fn category_description(o: &Map<String, Value>, out: &mut Vec<String>) {
    if let Some(x) = optional(o, "description") {
        let r = Str {
            min: None,
            max: Some((2000, "description tối đa 2000 ký tự")),
            pat: None,
            is: "description phải là chuỗi",
        };
        check_str(Some(x), &r, out);
    }
}

fn is_active(o: &Map<String, Value>, out: &mut Vec<String>) {
    if let Some(x) = defined(o, "is_active") {
        check_bool(Some(x), "is_active phải là boolean", out);
    }
}

/// `CreateProductCategoryDto`.
pub fn create_category(body: &Value) -> Result<CreateCategory, HttpError> {
    let mut o = as_obj(body);
    let mut e = Vec::new();
    unknown(&o, &["code", "name", "description", "sort_order", "is_active"], &mut e);
    let code = Str {
        min: Some((2, "Mã danh mục tối thiểu 2 ký tự")),
        max: Some((64, "Mã danh mục tối đa 64 ký tự")),
        pat: Some((code_ok, "Mã danh mục chỉ chứa chữ, số, gạch ngang và gạch dưới")),
        is: "code phải là chuỗi",
    };
    check_str(o.get("code"), &code, &mut e);
    category_name(o.get("name"), &mut e);
    category_description(&o, &mut e);
    sort_order(&o, &mut e);
    is_active(&o, &mut e);
    normalize_ints(&mut o, &["sort_order"]);
    finish(e, o)
}

/// `UpdateProductCategoryDto` (bỏ `code`).
pub fn update_category(body: &Value) -> Result<UpdateCategory, HttpError> {
    let mut o = as_obj(body);
    let mut e = Vec::new();
    unknown(&o, &["name", "description", "sort_order", "is_active"], &mut e);
    if let Some(x) = defined(&o, "name") {
        category_name(Some(x), &mut e);
    }
    category_description(&o, &mut e);
    sort_order(&o, &mut e);
    is_active(&o, &mut e);
    normalize_ints(&mut o, &["sort_order"]);
    finish(e, o)
}

fn type_errors(v: Option<&Value>, out: &mut Vec<String>) {
    if !v.and_then(Value::as_str).is_some_and(|t| ATTRIBUTE_TYPES.contains(&t)) {
        out.push(format!("type phải là 1 trong: {}", ATTRIBUTE_TYPES.join(", ")));
    }
}

fn label_errors(v: Option<&Value>, out: &mut Vec<String>) {
    let r = Str {
        min: Some((1, "label không được rỗng")),
        max: Some((255, "label tối đa 255 ký tự")),
        pat: None,
        is: "label phải là chuỗi",
    };
    check_str(v, &r, out);
}

/// Một phần tử của `options` (`AttributeOptionDto`).
fn option_errors(x: &Value, out: &mut Vec<String>) {
    let o = as_obj(x);
    unknown(&o, &["value", "label"], out);
    let value = Str {
        min: Some((1, "value không được rỗng")),
        max: Some((64, "value tối đa 64 ký tự")),
        pat: None,
        is: "value phải là chuỗi",
    };
    check_str(o.get("value"), &value, out);
    let label = Str {
        min: Some((1, "label không được rỗng")),
        max: Some((255, "label tối đa 255 ký tự")),
        pat: None,
        is: "label phải là chuỗi",
    };
    check_str(o.get("label"), &label, out);
}

/// `options`: `@IsArray`, `@ArrayMaxSize(100)`, `@ValidateNested({ each: true })`; lỗi lồng đứng sau lỗi của chính trường.
fn options_errors(x: &Value, out: &mut Vec<String>) {
    let arr = x.as_array();
    if arr.is_none_or(|a| a.len() > 100) {
        out.push("options tối đa 100 phần tử".to_owned());
    }
    if arr.is_none() {
        out.push("options phải là mảng".to_owned());
    }
    if arr.is_none() && !x.is_object() {
        out.push("nested property options must be either object or array".to_owned());
    }
    match arr {
        Some(a) => a.iter().for_each(|item| option_errors(item, out)),
        None if x.is_object() => option_errors(x, out),
        None => {}
    }
}

fn attribute_tail(o: &Map<String, Value>, out: &mut Vec<String>) {
    if let Some(x) = optional(o, "options") {
        options_errors(x, out);
    }
    if let Some(x) = defined(o, "is_required") {
        check_bool(Some(x), "is_required phải là boolean", out);
    }
    sort_order(o, out);
}

/// `CreateAttributeDefDto`.
pub fn create_attribute_def(body: &Value) -> Result<CreateAttributeDef, HttpError> {
    let mut o = as_obj(body);
    let mut e = Vec::new();
    unknown(
        &o,
        &["key", "label", "type", "options", "is_required", "sort_order"],
        &mut e,
    );
    let key = Str {
        min: Some((1, "key không được rỗng")),
        max: Some((64, "key tối đa 64 ký tự")),
        pat: Some((key_ok, "key chỉ chứa chữ thường/số/gạch dưới, bắt đầu bằng chữ")),
        is: "key phải là chuỗi",
    };
    check_str(o.get("key"), &key, &mut e);
    label_errors(o.get("label"), &mut e);
    type_errors(o.get("type"), &mut e);
    attribute_tail(&o, &mut e);
    normalize_ints(&mut o, &["sort_order"]);
    finish(e, o)
}

/// `UpdateAttributeDefDto` (bỏ `key`).
pub fn update_attribute_def(body: &Value) -> Result<UpdateAttributeDef, HttpError> {
    let mut o = as_obj(body);
    let mut e = Vec::new();
    unknown(&o, &["label", "type", "options", "is_required", "sort_order"], &mut e);
    if let Some(x) = defined(&o, "label") {
        label_errors(Some(x), &mut e);
    }
    if let Some(x) = defined(&o, "type") {
        type_errors(Some(x), &mut e);
    }
    attribute_tail(&o, &mut e);
    normalize_ints(&mut o, &["sort_order"]);
    finish(e, o)
}

fn project_name(v: Option<&Value>, out: &mut Vec<String>) {
    let r = Str {
        min: Some((2, "name must be longer than or equal to 2 characters")),
        max: Some((255, "name must be shorter than or equal to 255 characters")),
        pat: None,
        is: "name must be a string",
    };
    check_str(v, &r, out);
}

fn project_color(o: &Map<String, Value>, out: &mut Vec<String>) {
    if let Some(x) = optional(o, "color") {
        let r = Str {
            min: None,
            max: Some((50, "color must be shorter than or equal to 50 characters")),
            pat: None,
            is: "color must be a string",
        };
        check_str(Some(x), &r, out);
    }
}

fn project_code_ok(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `CreateProjectDto`.
pub fn create_project(body: &Value) -> Result<CreateProject, HttpError> {
    let o = as_obj(body);
    let mut e = Vec::new();
    unknown(&o, &["name", "code", "color"], &mut e);
    project_name(o.get("name"), &mut e);
    let code = Str {
        min: Some((2, "code must be longer than or equal to 2 characters")),
        max: Some((100, "code must be shorter than or equal to 100 characters")),
        pat: Some((project_code_ok, "Mã chỉ gồm chữ thường, số và dấu gạch dưới")),
        is: "code must be a string",
    };
    check_str(o.get("code"), &code, &mut e);
    project_color(&o, &mut e);
    finish(e, o)
}

/// `UpdateProjectDto`.
pub fn update_project(body: &Value) -> Result<UpdateProject, HttpError> {
    let o = as_obj(body);
    let mut e = Vec::new();
    unknown(&o, &["name", "color", "is_active"], &mut e);
    if let Some(x) = defined(&o, "name") {
        project_name(Some(x), &mut e);
    }
    project_color(&o, &mut e);
    if let Some(x) = defined(&o, "is_active") {
        check_bool(Some(x), "is_active must be a boolean value", &mut e);
    }
    finish(e, o)
}
