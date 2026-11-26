//! Đọc `server/contracts/dto/schema.json` (metadata class-validator/class-transformer do
//! `apps/monolith/src/__tests__/dto-validation-contract.spec.ts` xuất) và dịch sang luật Rust. Luật, điều kiện, @Transform
//! nào chưa có bản Rust thì nạp lỗi (không đoán).

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use super::conds::Cond;
use super::js::{JsVal, number_to_string, to_js_string};
use super::rules::Rule;
use super::transforms::Transform;

#[derive(Deserialize)]
struct RawClass {
    declared: Vec<String>,
    validated: Vec<String>,
    fields: BTreeMap<String, RawField>,
    defaults: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
struct RawField {
    rules: Vec<RawRule>,
    #[serde(default)]
    transforms: Vec<RawTransform>,
    #[serde(default, rename = "type")]
    ty: Option<Value>,
}

#[derive(Deserialize)]
struct RawRule {
    #[serde(rename = "type")]
    kind: String,
    name: Option<String>,
    constraints: Vec<Value>,
    message: Option<Value>,
    each: bool,
}

#[derive(Deserialize)]
struct RawTransform {
    #[serde(rename = "fn")]
    source: String,
}

/// Kiểu khai bằng `@Type(() => …)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeRef {
    Number,
    String,
    Boolean,
    /// `Object`, `Date`, `Array`: class-transformer không đổi giá trị nguyên thuỷ.
    Other,
    Dto(String),
}

/// Một metadata kiểm của một thuộc tính, theo thứ tự đăng ký.
#[derive(Debug, Clone)]
pub enum MetaKind {
    /// `@IsOptional`, `@ValidateIf`.
    Cond(Cond),
    /// `@ValidateNested`.
    Nested,
    /// Luật thường (`isString`, `min`…); `name` là khoá của lỗi.
    Custom { name: String, rule: Rule },
}

#[derive(Debug, Clone)]
pub struct Meta {
    pub kind: MetaKind,
    /// Câu riêng (`{ message: '…' }`); `None` = câu mặc định của class-validator.
    pub message: Option<String>,
    pub each: bool,
    /// `$constraint1`, `$constraint2`… đã đổi sang chuỗi như `constraintToString`.
    pub constraint_strings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Field {
    pub metas: Vec<Meta>,
    pub transforms: Vec<Transform>,
    pub ty: Option<TypeRef>,
}

#[derive(Debug, Clone)]
pub struct Class {
    pub name: String,
    /// `Object.keys(new Dto())`: trường khai trong class (theo thứ tự), có giá trị mặc định hoặc `undefined`.
    pub declared: Vec<String>,
    /// Thuộc tính có metadata kiểm (whitelist), theo thứ tự class-validator duyệt.
    pub validated: Vec<String>,
    pub fields: BTreeMap<String, Field>,
    pub defaults: BTreeMap<String, JsVal>,
}

/// Mọi DTO đã nạp.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    pub classes: BTreeMap<String, Class>,
}

impl Registry {
    /// Nạp từ nội dung `schema.json`. Lỗi liệt kê mọi chỗ chưa có bản Rust.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let raw: BTreeMap<String, RawClass> =
            serde_json::from_str(text).map_err(|e| format!("schema.json hỏng: {e}"))?;
        let mut problems = Vec::new();
        let mut classes = BTreeMap::new();
        for (name, rc) in raw {
            let mut fields = BTreeMap::new();
            for (prop, rf) in rc.fields {
                let mut f = Field::default();
                for r in rf.rules {
                    match compile_meta(&r, &prop) {
                        Ok(m) => f.metas.push(m),
                        Err(e) => problems.push(format!("{name}.{prop}: {e}")),
                    }
                }
                for t in rf.transforms {
                    match Transform::recognize(&t.source) {
                        Some(tr) => f.transforms.push(tr),
                        None => problems.push(format!("{name}.{prop}: @Transform chưa có bản Rust: {}", t.source)),
                    }
                }
                f.ty = rf.ty.map(|t| match t {
                    Value::String(s) if s == "Number" => TypeRef::Number,
                    Value::String(s) if s == "String" => TypeRef::String,
                    Value::String(s) if s == "Boolean" => TypeRef::Boolean,
                    Value::Object(o) => match o.get("dto") {
                        Some(Value::String(d)) => TypeRef::Dto(d.clone()),
                        _ => TypeRef::Other,
                    },
                    _ => TypeRef::Other,
                });
                fields.insert(prop, f);
            }
            let defaults = rc
                .defaults
                .iter()
                .map(|(k, v)| (k.clone(), JsVal::from_contract(v)))
                .collect();
            classes.insert(
                name.clone(),
                Class {
                    name,
                    declared: rc.declared,
                    validated: rc.validated,
                    fields,
                    defaults,
                },
            );
        }
        for c in classes.values() {
            for (p, f) in &c.fields {
                if let Some(TypeRef::Dto(d)) = &f.ty
                    && !classes.contains_key(d)
                {
                    problems.push(format!("{}.{p}: DTO lồng {d} không có trong schema", c.name));
                }
            }
        }
        if problems.is_empty() {
            Ok(Self { classes })
        } else {
            Err(problems.join("\n"))
        }
    }

    pub fn class(&self, name: &str) -> Option<&Class> {
        self.classes.get(name)
    }
}

fn compile_meta(r: &RawRule, prop: &str) -> Result<Meta, String> {
    let message = match &r.message {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => return Err(format!("message dạng hàm chưa hỗ trợ: {other}")),
    };
    let kind = match r.kind.as_str() {
        "conditionalValidation" => {
            if r.name.as_deref() == Some("isOptional") {
                MetaKind::Cond(Cond::optional())
            } else {
                let src = match r.constraints.first().and_then(|c| c.get("$fn")) {
                    Some(Value::String(s)) => s.clone(),
                    _ => return Err("ValidateIf không có hàm điều kiện".into()),
                };
                MetaKind::Cond(Cond::recognize(&src).ok_or_else(|| format!("@ValidateIf chưa có bản Rust: {src}"))?)
            }
        }
        "nestedValidation" => MetaKind::Nested,
        "customValidation" => {
            let name = r.name.clone().ok_or("luật không có tên")?;
            let rule = Rule::compile(&name, &r.constraints)?;
            MetaKind::Custom { name, rule }
        }
        "isDefined" => MetaKind::Custom {
            name: "isDefined".into(),
            rule: Rule::IsDefined,
        },
        // `@Allow`: chỉ đưa thuộc tính vào whitelist.
        "whitelistValidation" => MetaKind::Cond(Cond::always()),
        other => return Err(format!("loại metadata {other} chưa hỗ trợ (thuộc tính {prop})")),
    };
    Ok(Meta {
        kind,
        message,
        each: r.each,
        constraint_strings: r.constraints.iter().map(constraint_to_string).collect(),
    })
}

/// `constraintToString` của class-validator: mảng nối bằng ", ", còn lại `${c}`.
pub fn constraint_to_string(c: &Value) -> String {
    match c {
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                Value::Object(o) if o.contains_key("$undefined") => String::new(),
                other => constraint_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(o) => {
            if let Some(Value::String(src)) = o.get("$regex") {
                let flags = o.get("flags").and_then(Value::as_str).unwrap_or("");
                return format!("/{src}/{flags}");
            }
            if o.contains_key("$undefined") {
                return "undefined".into();
            }
            if let Some(Value::String(n)) = o.get("$number") {
                return n.clone();
            }
            "[object Object]".into()
        }
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        other => to_js_string(&JsVal::from_json(other)),
    }
}
