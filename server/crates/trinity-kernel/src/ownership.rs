//! Bộ đọc **tệp sở hữu** (`TRINITY_OWNERSHIP_FILE`, PLAN 4.14) dùng chung cho strangler proxy (K17) và scheduler
//! (K20): ai phục vụ nhóm route nào, ai chạy job nào, ai chạy migrate nền.
//!
//! ```json
//! {
//!   "routes": [
//!     { "prefix": "/api/v1/settings", "owner": "rust" },
//!     { "prefix": "/api/v1/settings/channel-guard", "owner": "node" },
//!     { "prefix": "/api/v1/contacts", "methods": ["GET"], "owner": "rust" }
//!   ],
//!   "jobs": { "lead-scoring": "rust" },
//!   "migrate": "node"
//! }
//! ```
//!
//! Luật khớp route: **tiền tố dài nhất + phương thức**. Tiền tố khớp theo ranh giới đoạn (`/api/v1/settings` khớp
//! `/api/v1/settings` và `/api/v1/settings/x`, không khớp `/api/v1/settings-x`). Cùng tiền tố thì dòng ghi phương thức
//! cụ thể thắng dòng không ghi (mọi phương thức). Hai dòng cùng tiền tố có chung một phương thức là lỗi, nên mỗi route
//! có **đúng một** chủ. Route, job không có dòng nào thuộc Node (mặc định của cấu hình lai).
//!
//! Tệp hỏng bị từ chối với lỗi chỉ dòng, cột; người gọi (K17) giữ bảng đang dùng.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Bên phục vụ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Owner {
    Rust,
    Node,
}

/// Phương thức HTTP được nhận trong tệp.
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/// Một dòng sở hữu route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteRule {
    /// Tiền tố đường dẫn, bắt đầu bằng `/`, không có `/` cuối (trừ `/`).
    pub prefix: String,
    /// Phương thức (chữ hoa); `None` = mọi phương thức.
    pub methods: Option<Vec<String>>,
    pub owner: Owner,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    prefix: String,
    #[serde(default)]
    methods: Option<Vec<String>>,
    owner: Owner,
}

impl TryFrom<RawRule> for RouteRule {
    type Error = String;

    fn try_from(r: RawRule) -> Result<Self, String> {
        let p = &r.prefix;
        if !p.starts_with('/') {
            return Err(format!("tiền tố \"{p}\" phải bắt đầu bằng /"));
        }
        if p.len() > 1 && p.ends_with('/') {
            return Err(format!("tiền tố \"{p}\" không được có / cuối"));
        }
        if p.contains(['?', '#', ' ']) || p.contains("//") || p.split('/').any(|s| s == "..") {
            return Err(format!("tiền tố \"{p}\" không hợp lệ"));
        }
        let methods = match r.methods {
            None => None,
            Some(ms) if ms.is_empty() => {
                return Err(format!("tiền tố \"{p}\": methods rỗng (bỏ trường = mọi phương thức)"));
            }
            Some(ms) => {
                let mut out: Vec<String> = Vec::with_capacity(ms.len());
                for m in ms {
                    if !METHODS.contains(&m.as_str()) {
                        return Err(format!(
                            "tiền tố \"{p}\": phương thức \"{m}\" không hợp lệ ({})",
                            METHODS.join(", ")
                        ));
                    }
                    if out.contains(&m) {
                        return Err(format!("tiền tố \"{p}\": phương thức {m} ghi hai lần"));
                    }
                    out.push(m);
                }
                Some(out)
            }
        };
        Ok(RouteRule {
            prefix: r.prefix,
            methods,
            owner: r.owner,
        })
    }
}

impl<'de> Deserialize<'de> for RouteRule {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        RawRule::deserialize(d)?.try_into().map_err(de::Error::custom)
    }
}

impl RouteRule {
    fn covers(&self, method: &str) -> bool {
        self.methods.as_ref().is_none_or(|ms| ms.iter().any(|m| m == method))
    }

    fn matches_path(&self, path: &str) -> bool {
        if self.prefix == "/" {
            return true;
        }
        path.strip_prefix(self.prefix.as_str())
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }

    /// Hai dòng cùng tiền tố tranh nhau một phương thức?
    fn conflicts(&self, other: &RouteRule) -> Option<String> {
        if self.prefix != other.prefix {
            return None;
        }
        match (&self.methods, &other.methods) {
            (None, None) => Some("mọi phương thức".to_owned()),
            (Some(a), Some(b)) => a.iter().find(|m| b.contains(m)).cloned(),
            // Một dòng cụ thể, một dòng mọi phương thức: dòng cụ thể thắng, không tranh.
            _ => None,
        }
    }
}

/// Tệp ở dạng thô: mỗi dòng route và mỗi giá trị job giữ lát cắt văn bản gốc, để lỗi ngữ nghĩa (trùng chủ, giá trị
/// sai) chỉ đúng dòng của nó — lỗi do `Deserialize` tự ném chỉ có vị trí nơi serde_json đang đọc, thường đã sang dòng
/// sau.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile<'a> {
    #[serde(default, borrow)]
    routes: Vec<&'a RawValue>,
    #[serde(default, borrow)]
    jobs: RawJobs<'a>,
    #[serde(default = "node")]
    migrate: Owner,
}

/// Các cặp tên job → giá trị thô theo thứ tự trong tệp (giữ cả khoá trùng để báo lỗi).
#[derive(Default)]
struct RawJobs<'a>(Vec<(String, &'a RawValue)>);

impl<'de: 'a, 'a> Deserialize<'de> for RawJobs<'a> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for V<'a> {
            type Value = RawJobs<'a>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("đối tượng tên job → \"rust\" | \"node\"")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawJobs<'a>, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, &'de RawValue>()? {
                    out.push((k, v));
                }
                Ok(RawJobs(out))
            }
        }
        d.deserialize_map(V(std::marker::PhantomData))
    }
}

fn node() -> Owner {
    Owner::Node
}

/// Kết quả tra route: chủ và dòng quyết định (None = không dòng nào khớp, thuộc Node).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteMatch<'a> {
    pub owner: Owner,
    pub rule: Option<&'a RouteRule>,
}

/// Bảng sở hữu đã kiểm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownership {
    rules: Vec<RouteRule>,
    jobs: BTreeMap<String, Owner>,
    migrate: Owner,
}

impl Default for Ownership {
    /// Chưa có tệp: mọi thứ thuộc Node.
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            jobs: BTreeMap::new(),
            migrate: Owner::Node,
        }
    }
}

/// Tệp sở hữu không dùng được.
#[derive(Debug, thiserror::Error)]
pub enum OwnershipError {
    #[error("không đọc được tệp sở hữu {path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("tệp sở hữu {path} hỏng ở dòng {line}, cột {column}: {message}")]
    Invalid {
        path: String,
        line: usize,
        column: usize,
        message: String,
    },
}

impl Ownership {
    /// Đọc tệp sở hữu.
    pub fn load(path: &Path) -> Result<Self, OwnershipError> {
        let shown = path.display().to_string();
        let text = std::fs::read_to_string(path).map_err(|source| OwnershipError::Io {
            path: shown.clone(),
            source,
        })?;
        Self::parse(&text, &shown)
    }

    /// Đọc nội dung tệp; `origin` chỉ dùng trong câu báo lỗi.
    pub fn parse(text: &str, origin: &str) -> Result<Self, OwnershipError> {
        let invalid = |line: usize, column: usize, message: String| OwnershipError::Invalid {
            path: origin.to_owned(),
            line,
            column,
            message,
        };
        let raw: RawFile<'_> = serde_json::from_str(text).map_err(|e| invalid(e.line(), e.column(), strip_pos(&e)))?;

        let mut rules: Vec<RouteRule> = Vec::with_capacity(raw.routes.len());
        for r in raw.routes {
            let (line, column) = position(text, r);
            let rule: RouteRule = serde_json::from_str(r.get()).map_err(|e| {
                // Lỗi cú pháp bên trong dòng: vị trí tương đối; lỗi giá trị: chỉ đầu dòng.
                let (l, c) = if e.is_data() || e.line() == 0 {
                    (line, column)
                } else if e.line() == 1 {
                    (line, column + e.column() - 1)
                } else {
                    (line + e.line() - 1, e.column())
                };
                invalid(l, c, strip_pos(&e))
            })?;
            if let Some(m) = rules.iter().find_map(|p| p.conflicts(&rule)) {
                let msg = format!(
                    "tiền tố \"{}\" ({m}) đã có chủ ở một dòng trước — mỗi route chỉ có một chủ",
                    rule.prefix
                );
                return Err(invalid(line, column, msg));
            }
            rules.push(rule);
        }

        let mut jobs = BTreeMap::new();
        for (name, v) in raw.jobs.0 {
            let (line, column) = position(text, v);
            if name.trim().is_empty() {
                return Err(invalid(line, column, "tên job rỗng".to_owned()));
            }
            let owner: Owner = serde_json::from_str(v.get()).map_err(|e| invalid(line, column, strip_pos(&e)))?;
            if jobs.insert(name.clone(), owner).is_some() {
                return Err(invalid(line, column, format!("job \"{name}\" ghi hai lần")));
            }
        }

        // Dài trước; cùng tiền tố thì dòng ghi phương thức trước dòng mọi phương thức.
        rules.sort_by(|a, b| {
            b.prefix
                .len()
                .cmp(&a.prefix.len())
                .then(a.methods.is_none().cmp(&b.methods.is_none()))
        });
        Ok(Self {
            rules,
            jobs,
            migrate: raw.migrate,
        })
    }

    /// Chủ của một request. `path` là đường dẫn không kèm query; `method` chữ hoa.
    pub fn route(&self, method: &str, path: &str) -> RouteMatch<'_> {
        // `rules` đã xếp theo ưu tiên nên dòng đầu tiên khớp là dòng thắng.
        match self.rules.iter().find(|r| r.matches_path(path) && r.covers(method)) {
            Some(rule) => RouteMatch {
                owner: rule.owner,
                rule: Some(rule),
            },
            None => RouteMatch {
                owner: Owner::Node,
                rule: None,
            },
        }
    }

    /// Mọi dòng khớp request ở mức ưu tiên cao nhất (dùng trong test "đúng một chủ").
    pub fn top_matches(&self, method: &str, path: &str) -> Vec<&RouteRule> {
        let hits: Vec<&RouteRule> = self
            .rules
            .iter()
            .filter(|r| r.matches_path(path) && r.covers(method))
            .collect();
        let Some(best) = hits.first() else { return hits };
        let key = |r: &RouteRule| (r.prefix.len(), r.methods.is_some());
        let top = key(best);
        hits.into_iter().filter(|r| key(r) == top).collect()
    }

    /// Chủ của một job (không có trong tệp = Node).
    pub fn job(&self, name: &str) -> Owner {
        self.jobs.get(name).copied().unwrap_or(Owner::Node)
    }

    /// Chủ của migrate nền.
    pub fn migrate(&self) -> Owner {
        self.migrate
    }

    /// Các dòng route theo thứ tự ưu tiên.
    pub fn rules(&self) -> &[RouteRule] {
        &self.rules
    }
}

/// Câu lỗi của serde_json bỏ đuôi " at line L column C" (vị trí đã nằm ở trường riêng).
fn strip_pos(e: &serde_json::Error) -> String {
    let full = e.to_string();
    full.rsplit_once(" at line ")
        .map_or(full.as_str(), |(m, _)| m)
        .to_owned()
}

/// Dòng, cột (đếm từ 1, cột theo ký tự) nơi lát cắt `raw` bắt đầu trong `text`.
fn position(text: &str, raw: &RawValue) -> (usize, usize) {
    let offset = (raw.get().as_ptr() as usize)
        .saturating_sub(text.as_ptr() as usize)
        .min(text.len());
    let before = &text[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    (line, column)
}

#[cfg(test)]
mod tests;
