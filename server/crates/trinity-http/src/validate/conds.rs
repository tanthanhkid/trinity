//! Điều kiện `@IsOptional` / `@ValidateIf`: điều kiện sai thì bỏ qua mọi luật của thuộc tính. Hàm điều kiện của bản TS
//! được nhận dạng từ mã nguồn (đã biên dịch) thành phép AND của các so sánh `x !== null/undefined/''`.

use super::js::JsVal;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Subject {
    /// Giá trị của chính thuộc tính.
    Value,
    /// Thuộc tính khác của cùng đối tượng.
    Field(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lit {
    Undefined,
    Null,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Clause {
    subject: Subject,
    /// `!=` (so lỏng, chỉ với null/undefined) hay `!==`.
    loose: bool,
    lit: Lit,
}

/// AND của các mệnh đề; rỗng = luôn đúng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cond(Vec<Clause>);

impl Cond {
    /// `@IsOptional()`: giá trị khác null và undefined.
    pub fn optional() -> Self {
        Cond(vec![
            Clause {
                subject: Subject::Value,
                loose: false,
                lit: Lit::Null,
            },
            Clause {
                subject: Subject::Value,
                loose: false,
                lit: Lit::Undefined,
            },
        ])
    }

    pub fn always() -> Self {
        Cond(Vec::new())
    }

    /// Nhận dạng `(o, v) => v !== undefined && …`, `(o) => o.x != null`, `(_obj, value) => { return …; }`.
    pub fn recognize(source: &str) -> Option<Self> {
        let src = source.split_whitespace().collect::<Vec<_>>().join(" ");
        let (params, body) = src.split_once("=>")?;
        let params: Vec<String> = params
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .split(',')
            .map(|p| p.split(':').next().unwrap_or("").trim().to_owned())
            .collect();
        let obj = params.first().cloned().unwrap_or_default();
        let val = params.get(1).cloned().unwrap_or_default();
        let mut body = body.trim();
        if let Some(b) = body.strip_prefix('{').and_then(|b| b.strip_suffix('}')) {
            body = b.trim().strip_prefix("return ")?.trim().trim_end_matches(';').trim();
        }
        while let Some(b) = body.strip_prefix('(').and_then(|b| b.strip_suffix(')')) {
            body = b.trim();
        }
        let mut clauses = Vec::new();
        for part in body.split("&&") {
            let part = part.trim();
            let (lhs, loose, rhs) = if let Some((l, r)) = part.split_once("!==") {
                (l.trim(), false, r.trim())
            } else if let Some((l, r)) = part.split_once("!=") {
                (l.trim(), true, r.trim())
            } else {
                return None;
            };
            let lit = match rhs {
                "undefined" | "void 0" => Lit::Undefined,
                "null" => Lit::Null,
                "''" | "\"\"" if !loose => Lit::Empty,
                _ => return None,
            };
            let ident = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$');
            let subject = match lhs.split_once('.') {
                None if !val.is_empty() && lhs == val => Subject::Value,
                Some((o, p)) if o == obj && ident(p) => Subject::Field(p.to_owned()),
                _ => return None,
            };
            clauses.push(Clause { subject, loose, lit });
        }
        Some(Cond(clauses))
    }

    /// Kiểm điều kiện với đối tượng và giá trị thuộc tính.
    pub fn holds(&self, object: &JsVal, value: &JsVal) -> bool {
        self.0.iter().all(|c| {
            let v = match &c.subject {
                Subject::Value => value,
                Subject::Field(f) => object.get(f),
            };
            if c.loose {
                return !v.is_nullish();
            }
            match c.lit {
                Lit::Undefined => *v != JsVal::Undefined,
                Lit::Null => *v != JsVal::Null,
                Lit::Empty => *v != JsVal::Str(String::new()),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nhan_dang_cac_dang_cua_ban_ts() {
        let obj = JsVal::Obj(vec![("m".into(), JsVal::Null)]);
        let c = Cond::recognize("(_o, v) => v !== undefined").unwrap();
        assert!(c.holds(&obj, &JsVal::Null) && !c.holds(&obj, &JsVal::Undefined));
        let c = Cond::recognize("(_obj, value) => value !== null && value !== ''").unwrap();
        assert!(!c.holds(&obj, &JsVal::Str(String::new())) && c.holds(&obj, &JsVal::Undefined));
        let c = Cond::recognize("(o) => o.m != null").unwrap();
        assert!(!c.holds(&obj, &JsVal::Num(1.0)));
        let c = Cond::recognize("(o) => o.a !== null &&\n        o.a !== undefined").unwrap();
        assert!(!c.holds(&obj, &JsVal::Num(1.0)));
        assert!(Cond::recognize("(o) => o.a > 3").is_none());
        assert!(Cond::recognize("(o, v) => other.a !== null").is_none());
    }
}
