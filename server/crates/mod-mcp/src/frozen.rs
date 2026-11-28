//! Hợp đồng đóng băng của Node (`server/contracts/mcp/`, C03): danh sách tool (tên, mô tả, `inputSchema`, `outputSchema`,
//! annotations) và `instructions`, phục vụ NGUYÊN VĂN. `tools/list` trả đúng từng byte của `tools.json` (bỏ khoảng trắng ngoài
//! chuỗi, giữ nguyên thứ tự khoá), nên client đã lưu danh sách tool không thấy khác biệt. Đối số được kiểm bằng `jsonschema` theo
//! chính schema đó.
//!
//! Khác schema đóng băng có chủ ý: zod (bản TS) BỎ khoá lạ chứ không từ chối, trong khi `additionalProperties: false` ở schema đóng
//! băng nghe như từ chối. Nên khoá lạ bị bỏ ([`strip_unknown`]) rồi mới kiểm trên bản schema đã gỡ `additionalProperties: false`.

use std::collections::HashMap;

use jsonschema::Validator;
use serde_json::Value;

pub const TOOLS_JSON: &str = include_str!("../../../contracts/mcp/tools.json");
pub const INSTRUCTIONS: &str = include_str!("../../../contracts/mcp/instructions.txt");

pub const SERVER_NAME: &str = "trinity-crm";
pub const SERVER_VERSION: &str = "1.0.0";

/// Bỏ khoảng trắng ngoài chuỗi JSON, giữ nguyên thứ tự khoá và nội dung chuỗi (đúng thứ `JSON.stringify` không có đối số in ra).
pub fn minify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut in_str, mut esc) = (false, false);
    for c in text.chars() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if !c.is_whitespace() {
            out.push(c);
        }
    }
    out
}

/// Một tool trong hợp đồng.
pub struct ToolContract {
    pub name: String,
    pub input_schema: Value,
    input: Validator,
    output: Option<Validator>,
}

impl ToolContract {
    /// Kiểm đối số (sau [`strip_unknown`]); `Err` là các câu lỗi kèm đường dẫn.
    pub fn check_input(&self, args: &Value) -> Result<(), String> {
        collect(&self.input, args)
    }

    /// Kiểm `structuredContent` theo `outputSchema`; tool không có `outputSchema` thì luôn qua.
    pub fn check_output(&self, v: &Value) -> Result<(), String> {
        self.output.as_ref().map_or(Ok(()), |o| collect(o, v))
    }

    pub fn has_output_schema(&self) -> bool {
        self.output.is_some()
    }
}

fn collect(v: &Validator, instance: &Value) -> Result<(), String> {
    let errs: Vec<String> = v
        .iter_errors(instance)
        .map(|e| {
            let p = e.instance_path().to_string();
            if p.is_empty() {
                e.to_string()
            } else {
                format!("{p}: {e}")
            }
        })
        .collect();
    if errs.is_empty() { Ok(()) } else { Err(errs.join("; ")) }
}

/// Bản sao schema đã gỡ MỌI `additionalProperties: false` (xem đầu tệp).
pub fn relax(schema: &Value) -> Value {
    match schema {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, v)| !(k.as_str() == "additionalProperties" && **v == Value::Bool(false)))
                .map(|(k, v)| (k.clone(), relax(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(relax).collect()),
        other => other.clone(),
    }
}

/// Bỏ khoá không khai trong `properties` (đệ quy qua `properties`, `items`, `additionalProperties` dạng schema) như `z.object()`
/// mặc định (strip). Union (`anyOf`/`oneOf`) giữ nguyên.
pub fn strip_unknown(schema: &Value, value: &mut Value) {
    match value {
        Value::Object(map) => {
            let props = schema.get("properties").and_then(Value::as_object);
            if let Some(props) = props {
                let extra = schema.get("additionalProperties").filter(|a| a.is_object());
                map.retain(|k, _| props.contains_key(k) || extra.is_some());
                for (k, v) in map.iter_mut() {
                    match props.get(k) {
                        Some(s) => strip_unknown(s, v),
                        None => {
                            if let Some(e) = extra {
                                strip_unknown(e, v);
                            }
                        }
                    }
                }
            } else if let Some(extra) = schema.get("additionalProperties").filter(|a| a.is_object()) {
                for v in map.values_mut() {
                    strip_unknown(extra, v);
                }
            }
        }
        Value::Array(a) => {
            if let Some(items) = schema.get("items").filter(|i| i.is_object()) {
                for v in a.iter_mut() {
                    strip_unknown(items, v);
                }
            }
        }
        _ => {}
    }
}

/// Toàn bộ hợp đồng, dựng một lần lúc khởi động.
pub struct Frozen {
    /// Mảng `tools` đã bỏ khoảng trắng (thân của `tools/list`).
    tools_array: String,
    order: Vec<String>,
    tools: HashMap<String, ToolContract>,
}

impl Frozen {
    /// Hợp đồng nhúng trong binary. Panic nếu tệp hỏng: lỗi lập trình, bắt ở test.
    pub fn embedded() -> Self {
        Self::from_text(TOOLS_JSON).expect("server/contracts/mcp/tools.json hợp lệ")
    }

    pub fn from_text(text: &str) -> Result<Self, String> {
        let doc: Value = serde_json::from_str(text).map_err(|e| format!("tools.json: {e}"))?;
        let list = doc
            .get("tools")
            .and_then(Value::as_array)
            .ok_or("tools.json thiếu mảng tools")?;
        // Mảng `tools` giữ nguyên văn (RawValue: đúng các byte của tệp, không đụng tới trường lạ trong chuỗi), rồi bỏ khoảng trắng.
        #[derive(serde::Deserialize)]
        struct Doc<'a> {
            #[serde(borrow)]
            tools: &'a serde_json::value::RawValue,
        }
        let raw: Doc<'_> = serde_json::from_str(text).map_err(|e| format!("tools.json: {e}"))?;
        let tools_array = minify(raw.tools.get());
        let mut order = Vec::new();
        let mut tools = HashMap::new();
        for t in list {
            let name = t
                .get("name")
                .and_then(Value::as_str)
                .ok_or("tool thiếu name")?
                .to_owned();
            let input_schema = t
                .get("inputSchema")
                .cloned()
                .ok_or_else(|| format!("{name}: thiếu inputSchema"))?;
            let input =
                jsonschema::validator_for(&relax(&input_schema)).map_err(|e| format!("{name}: inputSchema: {e}"))?;
            let output = t
                .get("outputSchema")
                .map(|o| jsonschema::validator_for(&relax(o)).map_err(|e| format!("{name}: outputSchema: {e}")))
                .transpose()?;
            order.push(name.clone());
            tools.insert(
                name.clone(),
                ToolContract {
                    name,
                    input_schema,
                    input,
                    output,
                },
            );
        }
        Ok(Self {
            tools_array,
            order,
            tools,
        })
    }

    /// Thân `result.tools` của `tools/list`.
    pub fn tools_array(&self) -> &str {
        &self.tools_array
    }

    pub fn names(&self) -> &[String] {
        &self.order
    }

    pub fn tool(&self, name: &str) -> Option<&ToolContract> {
        self.tools.get(name)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn minify_giu_chuoi_va_thu_tu() {
        assert_eq!(
            minify("{ \"b\": [1, 2 ],\n \"a\": \"x  y\\\" z\" }"),
            "{\"b\":[1,2],\"a\":\"x  y\\\" z\"}"
        );
    }

    #[test]
    fn hop_dong_nhung_dung_111_tool() {
        let f = Frozen::embedded();
        assert_eq!(f.len(), 111);
        assert!(f.tool("get_setup_guide").is_some());
        assert!(f.tools_array().starts_with("[{\"name\":\"get_setup_guide\""));
        assert!(f.tools_array().ends_with("}]"));
    }

    #[test]
    fn bo_khoa_la_roi_moi_kiem() {
        let f = Frozen::embedded();
        let t = f.tool("get_setup_guide").unwrap();
        let mut a = json!({ "agent": "claude", "khoa_la": 1 });
        strip_unknown(&t.input_schema, &mut a);
        assert_eq!(a, json!({ "agent": "claude" }));
        assert!(t.check_input(&a).is_ok());
        assert!(t.check_input(&json!({ "agent": "khong-co" })).is_err());
        // Schema đóng băng gốc từ chối khoá lạ; bản gỡ additionalProperties thì không.
        assert!(t.check_input(&json!({ "khoa_la": 1 })).is_ok());
    }
}
