//! Luật của class-validator 0.14 (kèm validator.js 13) mà DTO của bản TS dùng, cùng câu mặc định.

use std::sync::LazyLock;

use fancy_regex::Regex;
use serde_json::Value;

use super::js::{JsVal, strict_eq, utf16_len};

#[derive(Debug, Clone)]
pub enum Rule {
    IsString,
    IsInt,
    IsNumber {
        allow_nan: bool,
        allow_infinity: bool,
        max_decimal_places: Option<usize>,
    },
    IsBoolean,
    IsNotEmpty,
    IsDefined,
    Min(Option<f64>),
    Max(Option<f64>),
    MinLength(f64),
    MaxLength(f64),
    Length(Option<f64>, Option<f64>),
    Matches(Box<Regex>),
    IsIn(Vec<JsVal>),
    IsEnum(Vec<JsVal>),
    IsIso8601,
    IsArray,
    ArrayMaxSize(f64),
    ArrayMinSize(f64),
    ArrayNotEmpty,
    ArrayUnique,
    IsObject,
    IsEmail,
    IsUrl(UrlOptions),
    IsUuid(Option<String>),
    IsPositive,
}

#[derive(Debug, Clone)]
pub struct UrlOptions {
    protocols: Vec<String>,
    require_tld: bool,
    require_protocol: bool,
    require_host: bool,
    require_valid_protocol: bool,
    allow_protocol_relative_urls: bool,
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn is_undef(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::Object(o)) => o.contains_key("$undefined"),
        _ => false,
    }
}

fn opt_obj(v: Option<&Value>) -> serde_json::Map<String, Value> {
    match v {
        Some(Value::Object(o)) if !o.contains_key("$undefined") => o.clone(),
        _ => serde_json::Map::new(),
    }
}

impl Rule {
    /// Dịch luật theo tên và ràng buộc trong schema.
    pub fn compile(name: &str, c: &[Value]) -> Result<Self, String> {
        let need = |i: usize| num(c.get(i)).ok_or_else(|| format!("{name}: ràng buộc {i} không phải số"));
        Ok(match name {
            "isString" => Self::IsString,
            "isInt" => Self::IsInt,
            "isNumber" => {
                let o = opt_obj(c.first());
                Self::IsNumber {
                    allow_nan: o.get("allowNaN").and_then(Value::as_bool).unwrap_or(false),
                    allow_infinity: o.get("allowInfinity").and_then(Value::as_bool).unwrap_or(false),
                    max_decimal_places: o.get("maxDecimalPlaces").and_then(Value::as_u64).map(|n| n as usize),
                }
            }
            "isBoolean" => Self::IsBoolean,
            "isNotEmpty" => Self::IsNotEmpty,
            "isDefined" => Self::IsDefined,
            "min" => Self::Min(num(c.first())),
            "max" => Self::Max(num(c.first())),
            "minLength" => Self::MinLength(need(0)?),
            "maxLength" => Self::MaxLength(need(0)?),
            "isLength" => Self::Length(num(c.first()), num(c.get(1))),
            "matches" => {
                let (src, flags) = match c.first() {
                    Some(Value::Object(o)) if o.contains_key("$regex") => (
                        o["$regex"].as_str().unwrap_or("").to_owned(),
                        o.get("flags").and_then(Value::as_str).unwrap_or("").to_owned(),
                    ),
                    Some(Value::String(s)) => (
                        s.clone(),
                        if is_undef(c.get(1)) {
                            String::new()
                        } else {
                            c[1].as_str().unwrap_or("").to_owned()
                        },
                    ),
                    _ => return Err("matches: pattern lạ".into()),
                };
                Self::Matches(Box::new(js_regex(&src, &flags)?))
            }
            "isIn" => match c.first() {
                Some(Value::Array(a)) => Self::IsIn(a.iter().map(JsVal::from_contract).collect()),
                _ => return Err("isIn: ràng buộc không phải mảng".into()),
            },
            "isEnum" => match c.first() {
                Some(Value::Object(o)) => Self::IsEnum(o.values().map(JsVal::from_contract).collect()),
                _ => return Err("isEnum: ràng buộc không phải đối tượng".into()),
            },
            "isDateString" | "isIso8601" => {
                let o = opt_obj(c.first());
                if o.get("strict").and_then(Value::as_bool) == Some(true)
                    || o.get("strictSeparator").and_then(Value::as_bool) == Some(true)
                {
                    return Err(format!("{name}: tuỳ chọn strict chưa hỗ trợ"));
                }
                Self::IsIso8601
            }
            "isArray" => Self::IsArray,
            "arrayMaxSize" => Self::ArrayMaxSize(need(0)?),
            "arrayMinSize" => Self::ArrayMinSize(need(0)?),
            "arrayNotEmpty" => Self::ArrayNotEmpty,
            "arrayUnique" => {
                if c.first().is_some_and(|v| v.get("$fn").is_some()) {
                    return Err("arrayUnique với hàm định danh chưa hỗ trợ".into());
                }
                Self::ArrayUnique
            }
            "isObject" => Self::IsObject,
            "isEmail" => {
                if !opt_obj(c.first()).is_empty() {
                    return Err("isEmail: tuỳ chọn chưa hỗ trợ".into());
                }
                Self::IsEmail
            }
            "isUrl" => {
                let o = opt_obj(c.first());
                let b = |k: &str, d: bool| o.get(k).and_then(Value::as_bool).unwrap_or(d);
                Self::IsUrl(UrlOptions {
                    protocols: match o.get("protocols") {
                        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
                        _ => vec!["http".into(), "https".into(), "ftp".into()],
                    },
                    require_tld: b("require_tld", true),
                    require_protocol: b("require_protocol", false),
                    require_host: b("require_host", true),
                    require_valid_protocol: b("require_valid_protocol", true),
                    allow_protocol_relative_urls: b("allow_protocol_relative_urls", false),
                })
            }
            "isUuid" => Self::IsUuid(c.first().and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })),
            "isPositive" => Self::IsPositive,
            other => return Err(format!("luật {other} chưa có bản Rust")),
        })
    }

    pub fn check(&self, v: &JsVal) -> bool {
        let s = match v {
            JsVal::Str(s) => Some(s.as_str()),
            _ => None,
        };
        let arr = match v {
            JsVal::Arr(a) => Some(a),
            _ => None,
        };
        match self {
            Self::IsString => s.is_some(),
            Self::IsInt => matches!(v, JsVal::Num(n) if n.is_finite() && n.fract() == 0.0),
            Self::IsNumber {
                allow_nan,
                allow_infinity,
                max_decimal_places,
            } => match v {
                JsVal::Num(n) if n.is_infinite() => *allow_infinity,
                JsVal::Num(n) if n.is_nan() => *allow_nan,
                JsVal::Num(n) => max_decimal_places.is_none_or(|p| {
                    let t = super::js::number_to_string(*n);
                    t.split_once('.').map_or(0, |(_, f)| f.len()) <= p
                }),
                _ => false,
            },
            Self::IsBoolean => matches!(v, JsVal::Bool(_)),
            Self::IsNotEmpty => !matches!(v, JsVal::Undefined | JsVal::Null) && *v != JsVal::Str(String::new()),
            Self::IsDefined => !v.is_nullish(),
            Self::Min(m) => matches!((v, m), (JsVal::Num(n), Some(m)) if *n >= *m),
            Self::Max(m) => matches!((v, m), (JsVal::Num(n), Some(m)) if *n <= *m),
            Self::MinLength(m) => s.is_some_and(|s| validator_len(s) as f64 >= *m),
            Self::MaxLength(m) => s.is_some_and(|s| validator_len(s) as f64 <= *m),
            Self::Length(lo, hi) => s.is_some_and(|s| {
                let l = validator_len(s) as f64;
                l >= lo.unwrap_or(0.0) && hi.is_none_or(|h| l <= h)
            }),
            Self::Matches(re) => s.is_some_and(|s| re.is_match(s).unwrap_or(false)),
            Self::IsIn(list) | Self::IsEnum(list) => list.iter().any(|x| strict_eq(x, v)),
            Self::IsIso8601 => s.is_some_and(|s| ISO8601.is_match(s).unwrap_or(false)),
            Self::IsArray => arr.is_some(),
            Self::ArrayMaxSize(m) => arr.is_some_and(|a| a.len() as f64 <= *m),
            Self::ArrayMinSize(m) => arr.is_some_and(|a| a.len() as f64 >= *m),
            Self::ArrayNotEmpty => arr.is_some_and(|a| !a.is_empty()),
            Self::ArrayUnique => arr.is_some_and(|a| {
                // `c.indexOf(a) === b`: so bằng ===, NaN và đối tượng không bao giờ trùng nhau.
                a.iter()
                    .enumerate()
                    .all(|(i, x)| !a[..i].iter().any(|y| strict_eq(x, y)))
            }),
            Self::IsObject => matches!(v, JsVal::Obj(_)),
            Self::IsEmail => s.is_some_and(is_email),
            Self::IsUrl(o) => s.is_some_and(|s| is_url(s, o)),
            Self::IsUuid(ver) => s.is_some_and(|s| is_uuid(s, ver.as_deref())),
            Self::IsPositive => matches!(v, JsVal::Num(n) if *n > 0.0),
        }
    }

    /// Câu mặc định (chưa thay `$property`, `$constraintN`), `value` cần cho `@Length`.
    pub fn default_message(&self, value: &JsVal) -> &'static str {
        match self {
            Self::IsString => "$property must be a string",
            Self::IsInt => "$property must be an integer number",
            Self::IsNumber { .. } => "$property must be a number conforming to the specified constraints",
            Self::IsBoolean => "$property must be a boolean value",
            Self::IsNotEmpty | Self::ArrayNotEmpty => "$property should not be empty",
            Self::IsDefined => "$property should not be null or undefined",
            Self::Min(_) => "$property must not be less than $constraint1",
            Self::Max(_) => "$property must not be greater than $constraint1",
            Self::MinLength(_) => "$property must be longer than or equal to $constraint1 characters",
            Self::MaxLength(_) => "$property must be shorter than or equal to $constraint1 characters",
            Self::Length(lo, hi) => {
                // Theo `args.value.length` (UTF-16) của JS, không theo isLength.
                let len = match value {
                    JsVal::Str(s) => Some(utf16_len(s) as f64),
                    _ => None,
                };
                if lo.is_some() && (!value.truthy() || len.is_some_and(|l| l < lo.unwrap_or(0.0))) {
                    "$property must be longer than or equal to $constraint1 characters"
                } else if hi.is_some() && len.is_some_and(|l| l > hi.unwrap_or(f64::INFINITY)) {
                    "$property must be shorter than or equal to $constraint2 characters"
                } else {
                    "$property must be longer than or equal to $constraint1 and shorter than or equal to $constraint2 characters"
                }
            }
            Self::Matches(_) => "$property must match $constraint1 regular expression",
            Self::IsIn(_) => "$property must be one of the following values: $constraint1",
            Self::IsEnum(_) => "$property must be one of the following values: $constraint2",
            Self::IsIso8601 => "$property must be a valid ISO 8601 date string",
            Self::IsArray => "$property must be an array",
            Self::ArrayMaxSize(_) => "$property must contain no more than $constraint1 elements",
            Self::ArrayMinSize(_) => "$property must contain at least $constraint1 elements",
            Self::ArrayUnique => "All $property's elements must be unique",
            Self::IsObject => "$property must be an object",
            Self::IsEmail => "$property must be an email",
            Self::IsUrl(_) => "$property must be a URL address",
            Self::IsUuid(_) => "$property must be a UUID",
            Self::IsPositive => "$property must be a positive number",
        }
    }
}

/// `isLength` của validator.js: độ dài UTF-16 trừ cặp surrogate và chuỗi trình bày (ký tự + U+FE0E/U+FE0F).
fn validator_len(s: &str) -> usize {
    let units: Vec<u16> = s.encode_utf16().collect();
    let vs = |u: u16| u == 0xFE0E || u == 0xFE0F;
    let mut presentation = 0;
    let mut i = 0;
    while i + 1 < units.len() {
        if !vs(units[i]) && vs(units[i + 1]) {
            presentation += 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    let surrogate_pairs = s.chars().filter(|c| u32::from(*c) > 0xFFFF).count();
    units.len() - presentation - surrogate_pairs
}

/// Dịch regex JS (không cờ `u`) sang fancy-regex: `\d`, `\w`, `\D`, `\W` về dạng ASCII như JS.
pub fn js_regex(src: &str, flags: &str) -> Result<Regex, String> {
    let mut out = String::new();
    for f in flags.chars() {
        match f {
            'i' => out.push_str("(?i)"),
            'm' => out.push_str("(?m)"),
            's' => out.push_str("(?s)"),
            'g' | 'y' | 'u' | 'd' => {}
            other => return Err(format!("cờ regex {other} chưa hỗ trợ")),
        }
    }
    let mut chars = src.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let n = chars.next().ok_or("regex kết thúc bằng \\")?;
                match (n, in_class) {
                    ('d', false) => out.push_str("[0-9]"),
                    ('d', true) => out.push_str("0-9"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('w', false) => out.push_str("[A-Za-z0-9_]"),
                    ('w', true) => out.push_str("A-Za-z0-9_"),
                    ('W', false) => out.push_str("[^A-Za-z0-9_]"),
                    ('D' | 'W', true) => return Err("\\D, \\W trong lớp ký tự chưa hỗ trợ".into()),
                    ('/', _) => out.push('/'),
                    (other, _) => {
                        out.push('\\');
                        out.push(other);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
                if chars.peek() == Some(&'^') {
                    out.push('^');
                    chars.next();
                }
                // `]` đứng đầu lớp trong JS là lớp rỗng; hiếm gặp, coi là lỗi.
                if chars.peek() == Some(&']') {
                    return Err("lớp ký tự rỗng chưa hỗ trợ".into());
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '[' if in_class => out.push_str("\\["),
            _ => out.push(c),
        }
    }
    Regex::new(&out).map_err(|e| format!("regex /{src}/{flags} không dịch được: {e}"))
}

#[allow(clippy::expect_used)]
static ISO8601: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^([\+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(-?[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([\.,]\d+(?!:))?)?(\17[0-5]\d([\.,]\d+)?)?([zZ]|([\+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$",
        "",
    )
    .expect("regex ISO 8601 của validator.js")
});

fn re(src: &str, flags: &str) -> Regex {
    #[allow(clippy::expect_used)]
    js_regex(src, flags).expect("regex cố định của validator.js")
}

static EMAIL_USER_UTF8: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z\d!#\$%&'\*\+\-\/=\?\^_`{\|}~¡-퟿豈-﷏ﷰ-￯]+$", "i"));
static QUOTED_USER_UTF8: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e -퟿豈-﷏ﷰ-￯]|(\\[\x01-\x09\x0b\x0c\x0d-\x7f -퟿豈-﷏ﷰ-￯]))*$",
        "i",
    )
});
static TLD: LazyLock<Regex> = LazyLock::new(|| re(r"^([a-z¡-¨ª-퟿豈-﷏ﷰ-￯]{2,}|xn[a-z0-9-]{2,})$", "i"));
static FQDN_PART: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z_¡-￿0-9-]+$", "i"));

/// UTF-8 byte length (`isByteLength` của validator.js).
fn byte_len(s: &str) -> usize {
    s.len()
}

fn is_fqdn(s: &str, require_tld: bool, allow_underscores: bool) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    let tld = parts.last().copied().unwrap_or("");
    if require_tld
        && (parts.len() < 2 || !TLD.is_match(tld).unwrap_or(false) || tld.chars().any(super::js::is_js_space))
    {
        return false;
    }
    if !tld.is_empty() && tld.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    parts.iter().all(|p| {
        utf16_len(p) <= 63
            && FQDN_PART.is_match(p).unwrap_or(false)
            && !p.chars().any(|c| ('\u{ff01}'..='\u{ff5e}').contains(&c))
            && !p.starts_with('-')
            && !p.ends_with('-')
            && (allow_underscores || !p.contains('_'))
    })
}

/// `isEmail` của validator.js với tuỳ chọn mặc định.
fn is_email(s: &str) -> bool {
    if utf16_len(s) > 254 {
        return false;
    }
    let (user, domain) = match s.rfind('@') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => ("", s),
    };
    if byte_len(user) > 64 || byte_len(domain) > 254 {
        return false;
    }
    if !is_fqdn(domain, true, false) {
        return false;
    }
    if user.len() >= 2 && user.starts_with('"') && user.ends_with('"') {
        return QUOTED_USER_UTF8.is_match(&user[1..user.len() - 1]).unwrap_or(false);
    }
    user.split('.').all(|p| EMAIL_USER_UTF8.is_match(p).unwrap_or(false))
}

fn is_ip(s: &str) -> bool {
    s.parse::<std::net::IpAddr>().is_ok()
}

/// `isURL` của validator.js (các tuỳ chọn DTO dùng).
fn is_url(url: &str, o: &UrlOptions) -> bool {
    if url.is_empty() || url.chars().any(|c| super::js::is_js_space(c) || c == '<' || c == '>') {
        return false;
    }
    if url.starts_with("mailto:") || utf16_len(url) > 2084 {
        return false;
    }
    let url = url.split('#').next().unwrap_or("");
    let mut url = url.split('?').next().unwrap_or("").to_owned();
    let mut had_protocol = false;
    let proto_end = {
        let b = url.as_bytes();
        if !b.is_empty() && b[0].is_ascii_alphabetic() {
            let mut i = 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b"+-.".contains(&b[i])) {
                i += 1;
            }
            (i < b.len() && b[i] == b':').then_some(i)
        } else {
            None
        }
    };
    if let Some(i) = proto_end {
        let protocol = url[..i].to_lowercase();
        let after = url[i + 1..].to_owned();
        let mut clean = |url: &mut String| -> bool {
            had_protocol = true;
            if o.require_valid_protocol && !o.protocols.contains(&protocol) {
                return false;
            }
            *url = after.clone();
            true
        };
        if !after.starts_with("//") {
            let before_slash = after.split('/').next().unwrap_or("");
            if let Some(at) = before_slash.find('@') {
                let before_at = &before_slash[..at];
                let valid_auth = before_at
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.%:".contains(c));
                let encoded = before_at
                    .as_bytes()
                    .windows(3)
                    .any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit());
                if valid_auth && !encoded {
                    if o.require_protocol {
                        return false;
                    }
                } else if !clean(&mut url) {
                    return false;
                }
            } else if after.starts_with(|c: char| c.is_ascii_digit()) {
                if o.require_protocol {
                    return false;
                }
            } else if !clean(&mut url) {
                return false;
            }
        } else if !clean(&mut url) {
            return false;
        }
    } else if o.require_protocol {
        return false;
    }
    if let Some(rest) = url.strip_prefix("//") {
        if !had_protocol && !o.allow_protocol_relative_urls {
            return false;
        }
        url = rest.to_owned();
    }
    if url.is_empty() {
        return false;
    }
    let host_part = url.split('/').next().unwrap_or("").to_owned();
    if host_part.is_empty() && !o.require_host {
        return true;
    }
    let mut segs: Vec<&str> = host_part.split('@').collect();
    if segs.len() > 1 {
        if segs[0].is_empty() {
            return false;
        }
        let auth = segs.remove(0);
        if auth.split(':').count() > 2 {
            return false;
        }
        let mut up = auth.split(':');
        if up.next() == Some("") && up.next() == Some("") {
            return false;
        }
    }
    let hostname = segs.join("@");
    let (host, ipv6, port) = if let Some(rest) = hostname.strip_prefix('[') {
        match rest.split_once(']') {
            Some((ip, tail)) if tail.is_empty() || tail.starts_with(':') => (
                String::new(),
                Some(ip.to_owned()),
                tail.strip_prefix(':').map(str::to_owned),
            ),
            _ => (hostname.clone(), None, None),
        }
    } else {
        match hostname.split_once(':') {
            Some((h, p)) => (h.to_owned(), None, Some(p.to_owned())),
            None => (hostname.clone(), None, None),
        }
    };
    if let Some(p) = port.filter(|p| !p.is_empty())
        && (!p.chars().all(|c| c.is_ascii_digit()) || !p.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n)))
    {
        return false;
    }
    if host.is_empty() && ipv6.is_none() && !o.require_host {
        return true;
    }
    is_ip(&host)
        || is_fqdn(&host, o.require_tld, false)
        || ipv6.is_some_and(|v| v.parse::<std::net::Ipv6Addr>().is_ok())
}

fn is_uuid(s: &str, version: Option<&str>) -> bool {
    let hex = |p: &str, n: usize| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit());
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 5
        || !hex(parts[0], 8)
        || !hex(parts[1], 4)
        || !hex(parts[2], 4)
        || !hex(parts[3], 4)
        || !hex(parts[4], 12)
    {
        return false;
    }
    let ver = parts[2].chars().next().unwrap_or('0');
    let variant_ok = matches!(
        parts[3].chars().next().map(|c| c.to_ascii_lowercase()),
        Some('8' | '9' | 'a' | 'b')
    );
    match version {
        Some(v @ ("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8")) => v.starts_with(ver) && variant_ok,
        Some("loose") => true,
        None | Some("all") => {
            (('1'..='8').contains(&ver) && variant_ok)
                || s == "00000000-0000-0000-0000-000000000000"
                || s.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_nhu_validator_js() {
        for ok in [
            "2026-11-26",
            "2026-11-26T10:00:00Z",
            "2026-11-26T10:00:00.123+07:00",
            "2026-W48-4",
            "20261126",
        ] {
            assert!(ISO8601.is_match(ok).unwrap(), "{ok}");
        }
        for bad in ["2026-13-01", "26-11-2026", "x", "", "2026-11-26T25:00"] {
            assert!(!ISO8601.is_match(bad).unwrap(), "{bad}");
        }
    }

    #[test]
    fn email_url_uuid() {
        assert!(is_email("a@example.com"));
        assert!(is_email("nguyễn.văn@ví-dụ.vn"));
        assert!(!is_email("a@localhost"));
        assert!(!is_email("a..b@example.com"));
        let o = UrlOptions {
            protocols: vec!["https".into(), "http".into()],
            require_tld: false,
            require_protocol: true,
            require_host: true,
            require_valid_protocol: true,
            allow_protocol_relative_urls: false,
        };
        assert!(is_url("https://example.com/hook?x=1", &o));
        assert!(is_url("http://localhost:8080/x", &o));
        assert!(!is_url("example.com", &o));
        assert!(!is_url("ftp://example.com", &o));
        assert!(is_uuid("550e8400-e29b-41d4-a716-446655440000", Some("4")));
        assert!(!is_uuid("550e8400-e29b-11d4-a716-446655440000", Some("4")));
    }

    #[test]
    fn regex_js_d_chi_ascii() {
        let r = js_regex(r"^\d{3}$", "").unwrap();
        assert!(r.is_match("123").unwrap());
        assert!(!r.is_match("١٢٣").unwrap());
        assert!(js_regex(r"^\/(?![/\\])", "").unwrap().is_match("/a").unwrap());
    }
}
