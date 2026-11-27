//! `cargo xtask gen-models`: sinh `crates/trinity-db/src/models.rs` từ `server/prisma/schema.prisma`
//! (PLAN 4.4). Mỗi model còn dùng thành một struct (thứ tự trường như schema, cũng là thứ tự khoá JSON của Prisma),
//! derive `serde::Serialize` + `sqlx::FromRow`, kèm siêu dữ liệu bảng/cột để test pg so với `information_schema`.
//! Model đã gỡ (thành bảng lưu trữ, PLAN mục 2) không sinh. Test `models_rs_khop_schema` đỏ khi tệp sinh cũ.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Model đã gỡ, chỉ còn bảng lưu trữ (PLAN mục 2, "Sẽ gỡ (thành bảng lưu trữ)").
pub const ARCHIVED: [&str; 10] = [
    "GoogleConnection",
    "GoogleSheetSync",
    "GoogleSheetSyncRun",
    "Extension",
    "ExtensionVersion",
    "ExtensionRun",
    "ConnectorAccount",
    "ConnectorEvent",
    "ConnectorRecord",
    "PaymentIntent",
];

/// Mọi từ khoá Rust (đang dùng và dành riêng) trừ `self`/`Self`/`super`/`crate`.
const KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "do", "dyn", "else", "enum",
    "extern", "false", "final", "fn", "for", "gen", "if", "impl", "in", "let", "loop", "macro", "match", "mod", "move",
    "mut", "override", "priv", "pub", "ref", "return", "static", "struct", "trait", "true", "try", "type", "typeof",
    "unsafe", "unsized", "use", "virtual", "where", "while", "yield",
];
/// Từ khoá không dùng được cả dạng `r#`: đổi tên bằng đuôi `_` (JSON/cột giữ tên gốc nhờ `rename`).
const NO_RAW: [&str; 4] = ["self", "Self", "super", "crate"];
/// Định danh Rust cho tên Prisma: (định danh viết trong mã, tên không `r#`/đuôi `_` có giống tên gốc không).
fn rust_ident(name: &str) -> (String, bool) {
    if NO_RAW.contains(&name) {
        (format!("{name}_"), false)
    } else if KEYWORDS.contains(&name) {
        (format!("r#{name}"), true)
    } else {
        (name.to_owned(), true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Field {
    name: String,
    column: String,
    ty: String,
    list: bool,
    optional: bool,
    attrs: String,
    ignore: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Model {
    name: String,
    table: String,
    fields: Vec<Field>,
    ignore: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Enum {
    name: String,
    /// Tên kiểu trong Postgres (`@@map` nếu có).
    pg_name: String,
    /// (tên Prisma = giá trị JSON, giá trị trong DB = `@map` nếu có).
    values: Vec<(String, String)>,
}

/// Bỏ chú thích `//` ngoài chuỗi.
fn strip_comment(line: &str) -> &str {
    let mut in_str = false;
    let b = line.as_bytes();
    for i in 0..b.len() {
        match b[i] {
            b'"' if i == 0 || b[i - 1] != b'\\' => in_str = !in_str,
            b'/' if !in_str && b.get(i + 1) == Some(&b'/') => return &line[..i],
            _ => {}
        }
    }
    line
}

/// Đối số chuỗi của thuộc tính `attr("…")` trong `s`.
fn attr_arg<'a>(s: &'a str, attr: &str) -> Option<&'a str> {
    let start = s.find(&format!("{attr}(\""))? + attr.len() + 2;
    let end = s[start..].find('"')?;
    Some(&s[start..start + end])
}

fn parse(schema: &str) -> Result<(Vec<Model>, Vec<Enum>), String> {
    let mut models = Vec::new();
    let mut enums = Vec::new();
    let mut lines = schema.lines().map(strip_comment).map(str::trim);
    while let Some(line) = lines.next() {
        let mut words = line.split_whitespace();
        let (kind, name) = match (words.next(), words.next(), words.next()) {
            (Some(k @ ("model" | "enum")), Some(n), Some("{")) => (k, n.to_owned()),
            _ => continue,
        };
        let body: Vec<&str> = lines
            .by_ref()
            .take_while(|l| *l != "}")
            .filter(|l| !l.is_empty())
            .collect();
        if kind == "enum" {
            let mut pg_name = name.clone();
            let mut values = Vec::new();
            for l in &body {
                if l.starts_with("@@") {
                    if let Some(t) = attr_arg(l, "@@map") {
                        t.clone_into(&mut pg_name);
                    }
                    continue;
                }
                let first = l.split_whitespace().next().unwrap_or_default();
                if l.split_whitespace().any(|w| w == "@ignore") {
                    continue;
                }
                values.push((first.to_owned(), attr_arg(l, "@map").unwrap_or(first).to_owned()));
            }
            enums.push(Enum { name, pg_name, values });
            continue;
        }
        let mut table = name.clone();
        let mut fields = Vec::new();
        let mut model_ignore = false;
        for l in body {
            if let Some(rest) = l.strip_prefix("@@") {
                if rest.starts_with("ignore") {
                    model_ignore = true;
                }
                if let Some(t) = attr_arg(&format!("@@{rest}"), "@@map") {
                    t.clone_into(&mut table);
                }
                continue;
            }
            let mut parts = l.split_whitespace();
            let (Some(fname), Some(fty)) = (parts.next(), parts.next()) else {
                return Err(format!("model {name}: không đọc được dòng `{l}`"));
            };
            let attrs = parts.collect::<Vec<_>>().join(" ");
            let optional = fty.ends_with('?');
            let base = fty.trim_end_matches('?');
            let list = base.ends_with("[]");
            let base = base.trim_end_matches("[]").to_owned();
            let column = attr_arg(&attrs, "@map").unwrap_or(fname).to_owned();
            fields.push(Field {
                name: fname.to_owned(),
                column,
                ty: base,
                list,
                optional,
                ignore: attrs.split_whitespace().any(|w| w == "@ignore"),
                attrs,
            });
        }
        models.push(Model {
            name,
            table,
            fields,
            ignore: model_ignore,
        });
    }
    Ok((models, enums))
}

/// Tên kiểu gốc sau `@db.` (không đối số), nếu có.
fn db_attr(attrs: &str) -> Option<&str> {
    let rest = attrs.split("@db.").nth(1)?;
    let end = rest.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// (kiểu Rust, tên kiểu Postgres trong `information_schema.columns.udt_name`); `None` cho trường quan hệ.
/// Kiểu `@db.*` chưa hỗ trợ thì báo lỗi (không đoán).
fn map_type(f: &Field, enums: &[Enum], models: &[Model]) -> Result<Option<(String, String)>, String> {
    let db = db_attr(&f.attrs);
    let bad = |why: &str| {
        Err(format!(
            "trường `{}` ({}{}): {why}",
            f.name,
            f.ty,
            db.map(|d| format!(" @db.{d}")).unwrap_or_default()
        ))
    };
    let (rust, pg): (String, String) = match (f.ty.as_str(), db) {
        ("String", None | Some("Text")) => ("String".into(), "text".into()),
        ("String", Some("VarChar")) => ("String".into(), "varchar".into()),
        ("String", Some("Char")) => ("String".into(), "bpchar".into()),
        ("String", Some("Uuid")) => ("uuid::Uuid".into(), "uuid".into()),
        ("Int", None | Some("Integer")) => ("i32".into(), "int4".into()),
        ("Int", Some("SmallInt")) => ("i16".into(), "int2".into()),
        ("BigInt", None | Some("BigInt")) => ("JsBigInt".into(), "int8".into()),
        ("Float", None | Some("DoublePrecision")) => ("JsNumber".into(), "float8".into()),
        ("Decimal", None | Some("Decimal")) => ("DecimalJs".into(), "numeric".into()),
        ("Boolean", None | Some("Boolean")) => ("bool".into(), "bool".into()),
        ("DateTime", Some("Date")) => ("DbDate".into(), "date".into()),
        ("DateTime", Some("Timestamptz")) => ("Timestamp".into(), "timestamptz".into()),
        ("DateTime", None | Some("Timestamp")) => ("NaiveTimestamp".into(), "timestamp".into()),
        ("Json", None | Some("JsonB")) => ("JsonValue".into(), "jsonb".into()),
        ("Json", Some("Json")) => ("JsonValue".into(), "json".into()),
        ("Bytes", _) => return bad("Bytes chưa hỗ trợ (cần kiểu bọc khớp cách Prisma ghi JSON); thêm khi có cột"),
        (other, None) if enums.iter().any(|e| e.name == other) => {
            let e = enums.iter().find(|e| e.name == other).expect("enum");
            (rust_ident(&e.name).0, e.pg_name.clone())
        }
        (other, None) if models.iter().any(|m| m.name == other) => return Ok(None), // quan hệ tới model khác
        _ => return bad("kiểu hoặc `@db.*` chưa hỗ trợ"),
    };
    let (rust, pg) = if f.list {
        (format!("PgList<{rust}>"), format!("_{pg}"))
    } else {
        (rust, pg)
    };
    Ok(Some(if f.optional {
        (format!("Option<{rust}>"), pg)
    } else {
        (rust, pg)
    }))
}

/// Nội dung `models.rs` sinh từ `schema`.
pub fn render(schema: &str) -> Result<String, String> {
    let (models, enums) = parse(schema)?;
    let live: Vec<&Model> = models
        .iter()
        .filter(|m| !m.ignore && !ARCHIVED.contains(&m.name.as_str()))
        .collect();
    if let Some(m) = live.iter().find(|m| rust_ident(&m.name).0 != m.name) {
        return Err(format!("tên model `{}` trùng từ khoá Rust", m.name));
    }
    let mut o = String::new();
    o.push_str(
        "//! SINH TỰ ĐỘNG bởi `cargo xtask gen-models` từ `server/prisma/schema.prisma`. KHÔNG SỬA TAY.\n\
         //!\n\
         //! Struct model ứng với model Prisma còn dùng (thứ tự trường như schema = thứ tự khoá JSON của bản Node); kiểu\n\
         //! cột theo [`crate::types`]. Model đã thành bảng lưu trữ không có ở đây.\n\n\
         use crate::types::{DbDate, DecimalJs, JsBigInt, JsNumber, JsonValue, NaiveTimestamp, PgList, Timestamp};\n\n\
         /// Một cột: tên, kiểu Postgres (`udt_name`), có nhận NULL.\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct Column {\n    pub name: &'static str,\n    pub pg_type: &'static str,\n    pub nullable: bool,\n}\n\n\
         /// Một model: tên Prisma, tên bảng, các cột vô hướng.\n\
         #[derive(Debug, Clone, Copy, PartialEq, Eq)]\n\
         pub struct ModelInfo {\n    pub name: &'static str,\n    pub table: &'static str,\n    pub columns: &'static [Column],\n}\n\n\
         /// Struct model có bảng và danh sách cột.\n\
         pub trait Model {\n    const INFO: ModelInfo;\n}\n",
    );
    for e in &enums {
        let (ident, _) = rust_ident(&e.name);
        let _ = write!(
            o,
            "\n/// Enum Prisma `{n}` (kiểu Postgres `\"{pg}\"`).\n\
             #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, sqlx::Type)]\n\
             #[sqlx(type_name = \"{pg}\")]\n#[allow(non_camel_case_types)]\npub enum {ident} {{\n",
            n = e.name,
            pg = e.pg_name
        );
        for (name, db) in &e.values {
            let _ = writeln!(
                o,
                "    #[serde(rename = \"{name}\")]\n    #[sqlx(rename = \"{db}\")]\n    {},",
                rust_ident(name).0
            );
        }
        o.push_str("}\n");
    }
    for m in &live {
        let mut cols: Vec<(&Field, (String, String))> = Vec::new();
        for f in m.fields.iter().filter(|f| !f.ignore) {
            if let Some(t) = map_type(f, &enums, &models).map_err(|e| format!("model {}: {e}", m.name))? {
                cols.push((f, t));
            }
        }
        let _ = write!(
            o,
            "\n/// Model `{}`, bảng `{}`.\n\
             #[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]\npub struct {} {{\n",
            m.name, m.table, m.name
        );
        for (f, (rust, _)) in &cols {
            let (ident, same) = rust_ident(&f.name);
            // JSON dùng tên Prisma; cột dùng `@map`: ghi `rename` khi định danh khác tên gốc.
            if ident.trim_start_matches("r#") != f.name {
                let _ = writeln!(o, "    #[serde(rename = \"{}\")]", f.name);
            }
            if f.column != f.name || ident != f.name || !same {
                let _ = writeln!(o, "    #[sqlx(rename = \"{}\")]", f.column);
            }
            let _ = writeln!(o, "    pub {ident}: {rust},");
        }
        let _ = write!(
            o,
            "}}\n\nimpl Model for {} {{\n    const INFO: ModelInfo = ModelInfo {{\n        name: \"{}\",\n        table: \"{}\",\n        columns: &[\n",
            m.name, m.name, m.table
        );
        for (f, (_, pg)) in &cols {
            // Prisma tạo cột mảng không NOT NULL (`TEXT[]`), nên DB cho NULL dù client đọc ra `[]`.
            let _ = writeln!(
                o,
                "            Column {{ name: \"{}\", pg_type: \"{pg}\", nullable: {} }},",
                f.column,
                f.optional || f.list
            );
        }
        o.push_str("        ],\n    };\n}\n");
    }
    let _ = write!(
        o,
        "\n/// Mọi model còn dùng ({} model).\npub const MODELS: &[ModelInfo] = &[\n",
        live.len()
    );
    for m in &live {
        let _ = writeln!(o, "    {}::INFO,", m.name);
    }
    o.push_str("];\n");
    Ok(o)
}

/// Đường dẫn schema và tệp đích tính từ thư mục `server/`.
pub fn paths(server: &Path) -> (PathBuf, PathBuf) {
    (
        server.join("prisma/schema.prisma"),
        server.join("crates/trinity-db/src/models.rs"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> PathBuf {
        crate::root()
    }

    /// "Sinh lại và so" (PLAN 6.1): tệp đã commit phải đúng bằng kết quả sinh từ schema hiện tại.
    #[test]
    fn models_rs_khop_schema() {
        let (schema, out) = paths(&server());
        let want = render(&std::fs::read_to_string(schema).expect("đọc schema")).expect("sinh");
        let got = std::fs::read_to_string(out).expect("đọc models.rs");
        assert!(
            got == want,
            "models.rs cũ so với schema.prisma: chạy `cargo xtask gen-models`"
        );
    }

    #[test]
    fn dem_dung_model_theo_schema_va_bo_model_luu_tru() {
        let (schema, _) = paths(&server());
        let text = std::fs::read_to_string(schema).expect("đọc schema");
        let (models, _) = parse(&text).expect("đọc");
        let live = models.iter().filter(|m| !ARCHIVED.contains(&m.name.as_str())).count();
        // Đếm độc lập bằng số dòng `model X {` của schema (không dùng hằng: schema thêm bảng thì số tự theo).
        let declared = text
            .lines()
            .filter(|l| l.starts_with("model ") && l.trim_end().ends_with('{'))
            .count();
        assert_eq!(models.len(), declared, "parse bỏ sót hoặc thừa model");
        assert_eq!(live, declared - ARCHIVED.len());
        for a in ARCHIVED {
            assert!(
                models.iter().any(|m| m.name == a),
                "model lưu trữ {a} không còn trong schema"
            );
        }
    }

    #[test]
    fn doc_truong_va_chu_thich() {
        let s = "model A {\n  id Int @id // x\n  t DateTime? @db.Timestamptz(3)\n  d DateTime @db.Date\n  n DateTime @default(now())\n  \
                 u String @map(\"col_u\") @default(\"a//b\")\n  tags String[]\n  b B @relation(fields: [id], references: [id])\n  \
                 @@map(\"a_table\")\n}\nmodel B {\n  id Int @id\n}\nenum E {\n  x\n  y\n}\n";
        let (models, enums) = parse(s).expect("đọc");
        assert_eq!(models[0].table, "a_table");
        let types: Vec<_> = models[0]
            .fields
            .iter()
            .filter_map(|f| map_type(f, &enums, &models).expect("kiểu"))
            .collect();
        assert_eq!(
            types,
            [
                ("i32".to_owned(), "int4".to_owned()),
                ("Option<Timestamp>".to_owned(), "timestamptz".to_owned()),
                ("DbDate".to_owned(), "date".to_owned()),
                ("NaiveTimestamp".to_owned(), "timestamp".to_owned()),
                ("String".to_owned(), "text".to_owned()),
                ("PgList<String>".to_owned(), "_text".to_owned()),
            ]
        );
        assert_eq!(models[0].fields[4].column, "col_u");
        assert_eq!(enums[0].values[0], ("x".to_owned(), "x".to_owned()));
    }

    #[test]
    fn enum_map_tu_khoa_ignore_va_kieu_chua_ho_tro() {
        let s = "enum Kind {\n  a @map(\"A_db\")\n  b\n  gone @ignore\n  @@map(\"kind_t\")\n}\n\
                 model Self_ {\n  id Int @id\n}\n\
                 model M {\n  id Int @id\n  self String\n  type String\n  crate Int\n  k Kind\n  hidden Int @ignore\n}\n\
                 model Skip {\n  id Int @id\n  @@ignore\n}\n";
        let out = render(s).expect("sinh");
        assert!(out.contains("#[sqlx(type_name = \"kind_t\")]"));
        assert!(out.contains("#[serde(rename = \"a\")]\n    #[sqlx(rename = \"A_db\")]\n    a,"));
        assert!(!out.contains("gone") && !out.contains("hidden") && !out.contains("struct Skip"));
        assert!(out.contains("#[serde(rename = \"self\")]\n    #[sqlx(rename = \"self\")]\n    pub self_: String,"));
        assert!(out.contains("#[sqlx(rename = \"type\")]\n    pub r#type: String,"));
        assert!(out.contains("pub crate_: i32,"));
        assert!(out.contains("pub k: Kind,"));
        for bad in [
            "Bytes",
            "String @db.Xml",
            "Float @db.Real",
            "DateTime @db.Time(3)",
            "Decimal @db.Money",
            "Mystery",
        ] {
            let (ty, attr) = bad.split_once(' ').unwrap_or((bad, ""));
            let err = render(&format!("model M {{\n  id Int @id\n  c {ty} {attr}\n}}\n")).unwrap_err();
            assert!(err.contains("model M") && err.contains("trường `c`"), "{bad}: {err}");
        }
    }
}
