//! `@Transform` của bản TS, nhận dạng từ mã nguồn đã biên dịch. Mỗi dạng có bản Rust cùng ngữ nghĩa JS; dạng lạ làm
//! schema nạp lỗi. Golden `server/contracts/dto/transform.golden.json` phủ mọi @Transform trong `services/`.

use super::js::{JsVal, js_trim, parse_int, to_js_string, to_number};

#[derive(Debug, Clone, PartialEq)]
pub enum Transform {
    /// `typeof value === 'string' ? value.trim() : value`
    TrimString,
    /// `'true'` → true, `'false'` → false, còn lại giữ nguyên.
    BoolStrings,
    /// `value === 'true'`
    EqTrueString,
    /// `'1'|'true'|'yes'` → true, `'0'|'false'|'no'` → false, boolean giữ, còn lại undefined.
    BoolWords,
    /// `value === undefined || value === '' ? undefined : Number(value)`
    NumberUnlessEmpty,
    /// `parseInt(value)`
    ParseInt,
    /// `Math.min(Math.max(parseInt(value) || d, lo), hi)`
    ClampParseInt { default: f64, min: f64, max: f64 },
    /// `toStringArray(value)` của query-attendance-stats: CSV hoặc mảng → mảng chuỗi đã trim, bỏ rỗng.
    ToStringArray,
    /// `toIntArray(value)`: như trên nhưng `parseInt(…, 10)`, bỏ giá trị không hữu hạn.
    ToIntArray,
}

fn arrow_body(source: &str) -> Option<String> {
    let src = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let (params, body) = src.split_once("=>")?;
    if params.trim() != "({ value })" {
        return None;
    }
    let mut b = body.trim();
    while let Some(x) = b.strip_prefix('(').and_then(|x| x.strip_suffix(')')) {
        // Chỉ bỏ ngoặc bao trọn thân (không phải "(a) || (b)").
        if balanced(x) {
            b = x.trim();
        } else {
            break;
        }
    }
    Some(b.to_owned())
}

fn balanced(s: &str) -> bool {
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

impl Transform {
    pub fn recognize(source: &str) -> Option<Self> {
        let body = arrow_body(source)?;
        Some(match body.as_str() {
            "typeof value === 'string' ? value.trim() : value" => Self::TrimString,
            "value === 'true' ? true : value === 'false' ? false : value"
            | "value === 'true' || value === true ? true : value === 'false' || value === false ? false : value"
            | "{ if (value === 'true') return true; if (value === 'false') return false; return value; }" => {
                Self::BoolStrings
            }
            "value === 'true'" => Self::EqTrueString,
            "value === undefined || value === '' ? undefined : Number(value)" => Self::NumberUnlessEmpty,
            "parseInt(value)" => Self::ParseInt,
            "toStringArray(value)" => Self::ToStringArray,
            "toIntArray(value)" => Self::ToIntArray,
            "{ if (value === undefined || value === null) return undefined; if (typeof value === 'boolean') return value; \
             const v = String(value).toLowerCase(); if (v === '1' || v === 'true' || v === 'yes') return true; \
             if (v === '0' || v === 'false' || v === 'no') return false; return undefined; }" => Self::BoolWords,
            other => {
                let rest = other
                    .strip_prefix("Math.min(Math.max(parseInt(value) || ")?
                    .strip_suffix(')')?;
                let nums: Vec<f64> = rest
                    .split([',', ')'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::parse)
                    .collect::<Result<_, _>>()
                    .ok()?;
                match nums.as_slice() {
                    [d, lo, hi] => Self::ClampParseInt {
                        default: *d,
                        min: *lo,
                        max: *hi,
                    },
                    _ => return None,
                }
            }
        })
    }

    /// Áp lên giá trị đã qua `@Type`.
    pub fn apply(&self, value: JsVal) -> JsVal {
        match self {
            Self::TrimString => match value {
                JsVal::Str(s) => JsVal::Str(js_trim(&s).to_owned()),
                v => v,
            },
            Self::BoolStrings => match &value {
                JsVal::Str(s) if s == "true" => JsVal::Bool(true),
                JsVal::Str(s) if s == "false" => JsVal::Bool(false),
                _ => value,
            },
            Self::EqTrueString => JsVal::Bool(value == JsVal::Str("true".into())),
            Self::BoolWords => match value {
                JsVal::Undefined | JsVal::Null => JsVal::Undefined,
                JsVal::Bool(b) => JsVal::Bool(b),
                v => match to_js_string(&v).to_lowercase().as_str() {
                    "1" | "true" | "yes" => JsVal::Bool(true),
                    "0" | "false" | "no" => JsVal::Bool(false),
                    _ => JsVal::Undefined,
                },
            },
            Self::NumberUnlessEmpty => match value {
                JsVal::Undefined => JsVal::Undefined,
                JsVal::Str(s) if s.is_empty() => JsVal::Undefined,
                v => JsVal::Num(to_number(&v)),
            },
            Self::ParseInt => JsVal::Num(parse_int(&value, None)),
            Self::ClampParseInt { default, min, max } => {
                let x = parse_int(&value, None);
                let x = if x == 0.0 || x.is_nan() { *default } else { x };
                JsVal::Num(js_min(js_max(x, *min), *max))
            }
            Self::ToStringArray | Self::ToIntArray => {
                if value.is_nullish() {
                    return JsVal::Undefined;
                }
                let items: Vec<JsVal> = match value {
                    JsVal::Arr(a) => a,
                    v => to_js_string(&v).split(',').map(|s| JsVal::Str(s.to_owned())).collect(),
                };
                let out: Vec<JsVal> = if *self == Self::ToStringArray {
                    items
                        .iter()
                        .map(|v| js_trim(&to_js_string(v)).to_owned())
                        .filter(|s| !s.is_empty())
                        .map(JsVal::Str)
                        .collect()
                } else {
                    items
                        .iter()
                        .map(|v| parse_int(&JsVal::Str(js_trim(&to_js_string(v)).to_owned()), Some(10)))
                        .filter(|n| n.is_finite())
                        .map(JsVal::Num)
                        .collect()
                };
                if out.is_empty() {
                    JsVal::Undefined
                } else {
                    JsVal::Arr(out)
                }
            }
        }
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}
