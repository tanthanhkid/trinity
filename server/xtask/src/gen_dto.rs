//! Sinh khung struct Rust cho DTO từ `contracts/dto/schema.json` (metadata class-validator của bản TS). Kiểu suy từ
//! luật: `isString`/`matches`/`isEmail`/`isDateString` → `String`, `isInt` → `i64`, `isNumber` → `f64`, `isBoolean` →
//! `bool`, `isArray` + luật `each` → `Vec<…>`, `@ValidateNested` + `@Type` → DTO lồng, `@IsOptional`/`@ValidateIf` →
//! `Option<…>`. Không suy được thì `serde_json::Value` kèm ghi chú để người viết sửa tay.

use std::collections::BTreeSet;
use std::fmt::Write;

use serde_json::Value;

const KEYWORDS: &[&str] = &[
    "type", "match", "ref", "move", "loop", "fn", "mod", "use", "impl", "self", "where", "async",
];

pub fn generate(schema: &str, names: &[String]) -> Result<String, String> {
    let schema: Value = serde_json::from_str(schema).map_err(|e| format!("schema.json hỏng: {e}"))?;
    if names.is_empty() {
        let all: Vec<&str> = schema
            .as_object()
            .map(|o| o.keys().map(String::as_str).collect())
            .unwrap_or_default();
        return Err(format!("cần tên DTO; có: {}", all.join(", ")));
    }
    let mut out = String::new();
    let mut done = BTreeSet::new();
    let mut queue: Vec<String> = names.to_vec();
    while let Some(name) = queue.pop() {
        if !done.insert(name.clone()) {
            continue;
        }
        let class = schema
            .get(&name)
            .ok_or_else(|| format!("DTO {name} không có trong schema.json"))?;
        out.push_str(&gen_struct(&name, class, &mut queue));
    }
    Ok(out)
}

fn rule_names(field: &Value) -> Vec<(String, bool, Value)> {
    field["rules"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    let name = r["name"]
                        .as_str()
                        .or_else(|| r["type"].as_str())
                        .unwrap_or("")
                        .to_owned();
                    (name, r["each"].as_bool().unwrap_or(false), r["constraints"].clone())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn scalar(rules: &[(String, bool, Value)], each: bool, ty: Option<&str>) -> Option<String> {
    let has = |n: &str| rules.iter().any(|(r, e, _)| r == n && *e == each);
    if has("isInt") {
        return Some("i64".into());
    }
    if has("isNumber") || has("isPositive") || (!each && ty == Some("Number")) {
        return Some("f64".into());
    }
    if has("isBoolean") {
        return Some("bool".into());
    }
    if [
        "isString",
        "matches",
        "isEmail",
        "isDateString",
        "isIso8601",
        "isUrl",
        "isUuid",
        "maxLength",
        "minLength",
        "isLength",
    ]
    .iter()
    .any(|n| has(n))
    {
        return Some("String".into());
    }
    if let Some((_, _, c)) = rules.iter().find(|(r, e, _)| r == "isIn" && *e == each) {
        let vals = c.get(0).and_then(Value::as_array).cloned().unwrap_or_default();
        if vals.iter().all(Value::is_string) {
            return Some("String".into());
        }
        if vals.iter().all(Value::is_i64) {
            return Some("i64".into());
        }
    }
    None
}

fn gen_struct(name: &str, class: &Value, queue: &mut Vec<String>) -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        "/// Khung sinh bởi `cargo xtask gen-dto {name}` từ contracts/dto/schema.json — kiểm lại kiểu trước khi dùng."
    );
    let _ = writeln!(s, "#[derive(Debug, Clone, serde::Deserialize)]");
    let _ = writeln!(s, "pub struct {name} {{");
    let empty = serde_json::Map::new();
    let fields = class["fields"].as_object().unwrap_or(&empty);
    for prop in class["validated"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let field = &fields[prop];
        let rules = rule_names(field);
        let optional = rules
            .iter()
            .any(|(r, _, _)| r == "isOptional" || r == "conditionalValidation");
        let ty = field.get("type").and_then(Value::as_str);
        let dto = field.get("type").and_then(|t| t.get("dto")).and_then(Value::as_str);
        if let Some(d) = dto {
            queue.push(d.to_owned());
        }
        let is_array = rules
            .iter()
            .any(|(r, _, _)| r == "isArray" || r == "arrayMaxSize" || r == "arrayMinSize");
        let base = if is_array {
            match (dto, scalar(&rules, true, ty)) {
                (Some(d), _) => Some(format!("Vec<{d}>")),
                (None, Some(t)) => Some(format!("Vec<{t}>")),
                (None, None) => None,
            }
        } else if let Some(d) = dto {
            Some(d.to_owned())
        } else if rules.iter().any(|(r, _, _)| r == "isObject") {
            Some("serde_json::Value".into())
        } else {
            scalar(&rules, false, ty)
        };
        let (base, note) = match base {
            Some(b) => (b, ""),
            None => ("serde_json::Value".into(), " // TODO: không suy được kiểu từ luật"),
        };
        let ty = if optional { format!("Option<{base}>") } else { base };
        let snake = prop.chars().any(|c| c.is_ascii_uppercase());
        let mut ident = if snake { to_snake(prop) } else { prop.to_owned() };
        if KEYWORDS.contains(&ident.as_str()) {
            ident = format!("r#{ident}");
        }
        if snake {
            let _ = writeln!(s, "    #[serde(rename = \"{prop}\")]");
        }
        if optional {
            let _ = writeln!(s, "    #[serde(default)]");
        }
        let _ = writeln!(s, "    pub {ident}: {ty},{note}");
    }
    let _ = writeln!(s, "}}\n");
    let _ = writeln!(s, "impl trinity_http::validate::Dto for {name} {{");
    let _ = writeln!(s, "    const NAME: &'static str = \"{name}\";");
    let _ = writeln!(s, "}}\n");
    s
}

fn to_snake(s: &str) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sinh_khung_dto_mau() {
        let schema = include_str!("../../contracts/dto/schema.json");
        let code = generate(schema, &["CreateOrderDto".into()]).unwrap();
        assert!(code.contains("pub struct CreateOrderDto {"), "{code}");
        assert!(code.contains("pub items: Vec<OrderItemInputDto>,"), "{code}");
        assert!(code.contains("pub struct OrderItemInputDto {"), "{code}");
        assert!(code.contains("pub modifier_ids: Option<Vec<i64>>,"), "{code}");
        assert!(code.contains("pub note: Option<String>,"), "{code}");
        assert!(
            code.contains("const NAME: &'static str = \"CreateOrderDto\";"),
            "{code}"
        );
        assert!(generate(schema, &["KhongCo".into()]).is_err());
    }
}
