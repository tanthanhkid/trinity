//! `cargo xtask lint`: hai luật của PLAN 4.3 trên mọi tệp `.rs` dưới `crates/`.
//!
//! 1. **`sql-star`**: chuỗi (kể cả trong macro như `sqlx::query!`) có `SELECT *`, `SELECT t.*`, `, *`, `RETURNING *`.
//!    Khi hai schema công ty khác cột, statement cache gặp `cached plan must not change result type` (R005). Ngoại lệ
//!    có chủ đích: đặt `/* trinity-lint: allow-star */` ngay trong câu SQL.
//! 2. **`http-hold`**: `await` lời gọi HTTP ra ngoài (`.send()` của reqwest, hoặc đường dẫn có `reqwest`) khi đang
//!    giữ kết nối: sau `let x = ….acquire()/.begin()…;` trong cùng khối cho tới `drop(x)`, `x.commit()`,
//!    `x.rollback()`; hoặc trong hàm có tham số kiểu `TenantConn`/`TenantTx`/`PlatformConn`/`PlatformTx`. Phân tích
//!    theo cú pháp (không theo kiểu): biến giữ kết nối khai ở khối ngoài rồi dùng trong closure không được theo dõi.

use std::path::{Path, PathBuf};

use proc_macro2::{TokenStream, TokenTree};
use quote::ToTokens;
use syn::visit::{self, Visit};
use syn::{Block, Expr, ExprMethodCall, FnArg, ItemFn, LitStr, Local, Pat, Stmt};

/// Một vi phạm.
#[derive(Debug, PartialEq, Eq)]
pub struct Finding {
    pub file: PathBuf,
    pub line: usize,
    pub rule: &'static str,
    pub detail: String,
}

const ALLOW_STAR: &str = "trinity-lint: allow-star";
const GUARD_TYPES: [&str; 4] = ["TenantConn", "TenantTx", "PlatformConn", "PlatformTx"];

/// Kiểm mọi tệp `.rs` dưới `root` (thường là `server/crates`).
pub fn lint_dir(root: &Path) -> Result<Vec<Finding>, String> {
    let mut files = Vec::new();
    collect(root, &mut files).map_err(|e| format!("{}: {e}", root.display()))?;
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let src = std::fs::read_to_string(&f).map_err(|e| format!("{}: {e}", f.display()))?;
        out.extend(lint_source(&f, &src)?);
    }
    Ok(out)
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n == "target" || n == "fixtures") {
                continue;
            }
            collect(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
    Ok(())
}

/// Kiểm một tệp nguồn.
pub fn lint_source(file: &Path, src: &str) -> Result<Vec<Finding>, String> {
    let ast = syn::parse_file(src).map_err(|e| format!("{}: không đọc được: {e}", file.display()))?;
    let mut v = Linter {
        file: file.to_path_buf(),
        out: Vec::new(),
    };
    v.visit_file(&ast);
    v.out.sort_by(|a, b| (a.line, a.rule).cmp(&(b.line, b.rule)));
    v.out.dedup();
    Ok(v.out)
}

struct Linter {
    file: PathBuf,
    out: Vec<Finding>,
}

impl Linter {
    fn push(&mut self, line: usize, rule: &'static str, detail: String) {
        self.out.push(Finding {
            file: self.file.clone(),
            line,
            rule,
            detail,
        });
    }

    fn check_sql(&mut self, value: &str, line: usize) {
        if !value.contains(ALLOW_STAR) && has_star_projection(value) {
            let short: String = value
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect();
            self.push(line, "sql-star", format!("liệt kê cột thay cho `*`: {short}"));
        }
    }

    fn scan_tokens(&mut self, ts: TokenStream) {
        for tt in ts {
            match tt {
                TokenTree::Group(g) => self.scan_tokens(g.stream()),
                TokenTree::Literal(l) => {
                    if let Ok(s) = syn::parse_str::<LitStr>(&l.to_string()) {
                        self.check_sql(&s.value(), l.span().start().line);
                    }
                }
                _ => {}
            }
        }
    }

    /// Quét tuần tự các câu lệnh của một khối với tập biến đang giữ kết nối `live` (ban đầu).
    fn check_block(&mut self, block: &Block, mut live: Vec<String>) {
        for stmt in &block.stmts {
            if !live.is_empty()
                && let Some(line) = first_http_call(stmt)
            {
                self.push(
                    line,
                    "http-hold",
                    format!(
                        "gọi HTTP ra ngoài khi đang giữ kết nối `{}`; trả kết nối trước",
                        live.join("`, `")
                    ),
                );
            }
            if let Stmt::Local(local) = stmt
                && let Some(name) = guard_binding(local)
            {
                live.push(name);
            }
            live.retain(|name| !releases(stmt, name));
        }
    }
}

impl<'ast> Visit<'ast> for Linter {
    // Thuộc tính (kể cả chú thích tài liệu `///`) không phải SQL.
    fn visit_attribute(&mut self, _: &'ast syn::Attribute) {}

    fn visit_lit_str(&mut self, l: &'ast LitStr) {
        self.check_sql(&l.value(), l.span().start().line);
    }

    fn visit_macro(&mut self, m: &'ast syn::Macro) {
        self.scan_tokens(m.tokens.clone());
        visit::visit_macro(self, m);
    }

    fn visit_item_fn(&mut self, f: &'ast ItemFn) {
        let params = guard_params(f.sig.inputs.iter());
        if !params.is_empty() {
            self.check_block(&f.block, params);
        }
        visit::visit_item_fn(self, f);
    }

    fn visit_impl_item_fn(&mut self, f: &'ast syn::ImplItemFn) {
        let params = guard_params(f.sig.inputs.iter());
        if !params.is_empty() {
            self.check_block(&f.block, params);
        }
        visit::visit_impl_item_fn(self, f);
    }

    fn visit_block(&mut self, b: &'ast Block) {
        self.check_block(b, Vec::new());
        visit::visit_block(self, b);
    }
}

fn guard_params<'a>(inputs: impl Iterator<Item = &'a FnArg>) -> Vec<String> {
    inputs
        .filter_map(|a| match a {
            FnArg::Typed(t) => {
                let ty = quote_ty(&t.ty);
                if GUARD_TYPES.iter().any(|g| ty.contains(g))
                    && let Pat::Ident(id) = &*t.pat
                {
                    return Some(id.ident.to_string());
                }
                None
            }
            FnArg::Receiver(_) => None,
        })
        .collect()
}

fn quote_ty(ty: &syn::Type) -> String {
    ty.to_token_stream().to_string()
}

/// `let x = …acquire()…;` hoặc `…begin()…` ⇒ `Some("x")`.
fn guard_binding(local: &Local) -> Option<String> {
    let init = local.init.as_ref()?;
    let mut f = MethodFinder {
        names: &["acquire", "begin"],
        found: None,
    };
    f.visit_expr(&init.expr);
    f.found?;
    match &local.pat {
        Pat::Ident(id) => Some(id.ident.to_string()),
        Pat::Type(t) => match &*t.pat {
            Pat::Ident(id) => Some(id.ident.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// Câu lệnh nhả biến: `drop(x)`, `x.commit()`, `x.rollback()`.
fn releases(stmt: &Stmt, name: &str) -> bool {
    struct R<'a> {
        name: &'a str,
        hit: bool,
    }
    impl<'ast> Visit<'ast> for R<'_> {
        fn visit_expr_call(&mut self, c: &'ast syn::ExprCall) {
            if let Expr::Path(p) = &*c.func
                && p.path.is_ident("drop")
                && c.args.iter().any(|a| is_ident(a, self.name))
            {
                self.hit = true;
            }
            visit::visit_expr_call(self, c);
        }
        fn visit_expr_method_call(&mut self, m: &'ast ExprMethodCall) {
            if (m.method == "commit" || m.method == "rollback") && is_ident(&m.receiver, self.name) {
                self.hit = true;
            }
            visit::visit_expr_method_call(self, m);
        }
    }
    let mut r = R { name, hit: false };
    r.visit_stmt(stmt);
    r.hit
}

fn is_ident(e: &Expr, name: &str) -> bool {
    matches!(e, Expr::Path(p) if p.path.is_ident(name))
}

struct MethodFinder<'a> {
    names: &'a [&'a str],
    found: Option<usize>,
}

impl<'ast> Visit<'ast> for MethodFinder<'_> {
    fn visit_expr_method_call(&mut self, m: &'ast ExprMethodCall) {
        if self.found.is_none() && self.names.iter().any(|n| m.method == n) {
            self.found = Some(m.method.span().start().line);
        }
        visit::visit_expr_method_call(self, m);
    }
}

/// Dòng của lời gọi HTTP đầu tiên trong câu lệnh: `.send()` hoặc đường dẫn có `reqwest`.
fn first_http_call(stmt: &Stmt) -> Option<usize> {
    struct H {
        found: Option<usize>,
    }
    impl<'ast> Visit<'ast> for H {
        fn visit_expr_method_call(&mut self, m: &'ast ExprMethodCall) {
            if self.found.is_none() && m.method == "send" {
                self.found = Some(m.method.span().start().line);
            }
            visit::visit_expr_method_call(self, m);
        }
        fn visit_path(&mut self, p: &'ast syn::Path) {
            if self.found.is_none()
                && let Some(seg) = p.segments.iter().find(|s| s.ident == "reqwest")
            {
                self.found = Some(seg.ident.span().start().line);
            }
            visit::visit_path(self, p);
        }
    }
    let mut h = H { found: None };
    h.visit_stmt(stmt);
    h.found
}

/// Câu SQL có chiếu `*`: `*` đứng sau `SELECT`, `DISTINCT`, `ALL`, `RETURNING` hoặc `,` (có thể kèm `bảng.`).
/// Bỏ qua chuỗi `'…'`, định danh `"…"`, chú thích. `count(*)`, `a * b` không bị bắt.
pub fn has_star_projection(sql: &str) -> bool {
    let toks = tokenize(sql);
    for (i, t) in toks.iter().enumerate() {
        if t != "*" {
            continue;
        }
        let mut j = i;
        // `bảng.*`
        if j >= 2 && toks[j - 1] == "." && is_word(&toks[j - 2]) {
            j -= 2;
        }
        if j == 0 {
            continue;
        }
        let prev = toks[j - 1].to_ascii_uppercase();
        if matches!(prev.as_str(), "SELECT" | "DISTINCT" | "ALL" | "RETURNING" | ",") {
            return true;
        }
    }
    false
}

fn is_word(t: &str) -> bool {
    t.starts_with(|c: char| c.is_alphabetic() || c == '_' || c == '"')
}

fn tokenize(sql: &str) -> Vec<String> {
    let c: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch == '-' && c.get(i + 1) == Some(&'-') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < c.len() && !(c[i] == '*' && c[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if ch == '\'' {
            i += 1;
            while i < c.len() && c[i] != '\'' {
                i += 1;
            }
            i += 1;
            out.push("'".to_owned());
        } else if ch == '"' {
            let s = i;
            i += 1;
            while i < c.len() && c[i] != '"' {
                i += 1;
            }
            i += 1;
            out.push(c[s..i.min(c.len())].iter().collect());
        } else if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            let s = i;
            while i < c.len() && (c[i].is_alphanumeric() || c[i] == '_' || c[i] == '$') {
                i += 1;
            }
            out.push(c[s..i].iter().collect());
        } else {
            out.push(ch.to_string());
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bat_select_sao() {
        for sql in [
            "SELECT * FROM contacts",
            "select\n  *\nfrom t",
            "SELECT DISTINCT * FROM t",
            "SELECT c.* FROM contacts c",
            "SELECT id, * FROM t",
            "UPDATE t SET a = 1 RETURNING *",
            "INSERT INTO t (a) VALUES (1) returning t.*",
            "SELECT \"c\".* FROM contacts \"c\"",
        ] {
            assert!(has_star_projection(sql), "{sql}");
        }
        for sql in [
            "SELECT count(*) FROM t",
            "SELECT a * b FROM t",
            "SELECT id FROM t -- SELECT *",
            "SELECT '*', ', *' FROM t",
            "SELECT id FROM t /* SELECT * */",
            "SELECT 2 * 3",
            "SELECT id, name FROM t RETURNING id",
        ] {
            assert!(!has_star_projection(sql), "{sql}");
        }
    }

    fn lint(src: &str) -> Vec<(usize, &'static str)> {
        lint_source(Path::new("x.rs"), src)
            .unwrap()
            .into_iter()
            .map(|f| (f.line, f.rule))
            .collect()
    }

    #[test]
    fn luat_sql_trong_chuoi_va_macro() {
        let src = r#"
fn a() {
    let _ = sqlx::query("SELECT * FROM t");
    let _ = sqlx::query!("SELECT id FROM t RETURNING *");
    let _ = sqlx::query("SELECT * /* trinity-lint: allow-star */ FROM t");
    let _ = sqlx::query("SELECT count(*) FROM t");
}
"#;
        assert_eq!(lint(src), vec![(3, "sql-star"), (4, "sql-star")]);
    }

    #[test]
    fn luat_http_khi_giu_ket_noi() {
        let src = r#"
async fn bad(db: TenantDb, http: Client) {
    let mut conn = db.acquire().await?;
    sqlx::query("SELECT 1").execute(&mut *conn).await?;
    http.post(url).send().await?;
}
async fn ok(db: TenantDb, http: Client) {
    let mut conn = db.acquire().await?;
    sqlx::query("SELECT 1").execute(&mut *conn).await?;
    drop(conn);
    http.post(url).send().await?;
    let tx = db.begin().await?;
    tx.commit().await?;
    reqwest::get(url).await?;
}
async fn bad_tx(db: TenantDb) {
    let tx = db.begin().await?;
    if x {
        let r = reqwest::get(url).await?;
    }
    tx.commit().await?;
}
async fn bad_param(conn: &mut TenantConn, http: Client) {
    http.get(url).send().await?;
}
async fn ok_param(conn: &mut Other, http: Client) {
    http.get(url).send().await?;
}
"#;
        assert_eq!(lint(src), vec![(5, "http-hold"), (19, "http-hold"), (24, "http-hold")]);
    }
}
