//! `cargo xtask gen-models`: sinh `crates/trinity-db/src/models.rs` từ `packages/prisma/prisma/schema.prisma`
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

/// Từ khoá Rust dùng được dạng `r#tên` (serde bỏ `r#` khi ghi JSON; sqlx đọc cột theo `rename`).
const KEYWORDS: [&str; 38] = [
    "as", "async", "await", "break", "const", "continue", "dyn", "else", "enum", "extern", "false", "fn", "for", "gen",
    "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static", "struct",
    "trait", "true", "type", "unsafe", "use", "where", "while", "abstract", "become", "box",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Field {
    name: String,
    column: String,
    ty: String,
    list: bool,
    optional: bool,
    attrs: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Model {
    name: String,
    table: String,
    fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Enum {
    name: String,
    values: Vec<String>,
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
            let values = body
                .iter()
                .filter(|l| !l.starts_with('@'))
                .map(|l| l.to_owned().to_owned())
                .collect();
            enums.push(Enum { name, values });
            continue;
        }
        let mut table = name.clone();
        let mut fields = Vec::new();
        for l in body {
            if let Some(rest) = l.strip_prefix("@@") {
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
                attrs,
            });
        }
        models.push(Model { name, table, fields });
    }
    Ok((models, enums))
}

/// (kiểu Rust, tên kiểu Postgres trong `information_schema.columns.udt_name`).
fn map_type(f: &Field, enums: &[Enum]) -> Option<(String, String)> {
    let a = &f.attrs;
    let (rust, pg) = match f.ty.as_str() {
        "String" if a.contains("@db.Uuid") => ("uuid::Uuid".to_owned(), "uuid"),
        "String" if a.contains("@db.VarChar") => ("String".to_owned(), "varchar"),
        "String" if a.contains("@db.Char") => ("String".to_owned(), "bpchar"),
        "String" => ("String".to_owned(), "text"),
        "Int" => ("i32".to_owned(), "int4"),
        "BigInt" => ("JsBigInt".to_owned(), "int8"),
        "Float" => ("JsNumber".to_owned(), "float8"),
        "Decimal" => ("DecimalJs".to_owned(), "numeric"),
        "Boolean" => ("bool".to_owned(), "bool"),
        "DateTime" if a.contains("@db.Date") => ("DbDate".to_owned(), "date"),
        "DateTime" if a.contains("@db.Timestamptz") => ("Timestamp".to_owned(), "timestamptz"),
        "DateTime" => ("NaiveTimestamp".to_owned(), "timestamp"),
        "Json" => ("JsonValue".to_owned(), "jsonb"),
        "Bytes" => ("Vec<u8>".to_owned(), "bytea"),
        other if enums.iter().any(|e| e.name == other) => (other.to_owned(), other),
        _ => return None, // quan hệ tới model khác
    };
    let (rust, pg) = if f.list {
        (format!("Vec<{rust}>"), format!("_{pg}"))
    } else {
        (rust, pg.to_owned())
    };
    Some(if f.optional {
        (format!("Option<{rust}>"), pg)
    } else {
        (rust, pg)
    })
}

/// Nội dung `models.rs` sinh từ `schema`.
pub fn render(schema: &str) -> Result<String, String> {
    let (models, enums) = parse(schema)?;
    let live: Vec<&Model> = models.iter().filter(|m| !ARCHIVED.contains(&m.name.as_str())).collect();
    let mut o = String::new();
    o.push_str(
        "//! SINH TỰ ĐỘNG bởi `cargo xtask gen-models` từ `packages/prisma/prisma/schema.prisma`. KHÔNG SỬA TAY.\n\
         //!\n\
         //! Struct model ứng với model Prisma còn dùng (thứ tự trường như schema = thứ tự khoá JSON của bản Node); kiểu\n\
         //! cột theo [`crate::types`]. Model đã thành bảng lưu trữ không có ở đây.\n\n\
         use crate::types::{DbDate, DecimalJs, JsBigInt, JsNumber, JsonValue, NaiveTimestamp, Timestamp};\n\n\
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
        let _ = write!(
            o,
            "\n/// Enum Prisma `{n}` (kiểu Postgres `\"{n}\"`).\n\
             #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, sqlx::Type)]\n\
             #[sqlx(type_name = \"{n}\")]\n#[allow(non_camel_case_types)]\npub enum {n} {{\n",
            n = e.name
        );
        for v in &e.values {
            let _ = writeln!(
                o,
                "    #[serde(rename = \"{v}\")]\n    #[sqlx(rename = \"{v}\")]\n    {v},"
            );
        }
        o.push_str("}\n");
    }
    for m in &live {
        let cols: Vec<(&Field, (String, String))> = m
            .fields
            .iter()
            .filter_map(|f| map_type(f, &enums).map(|t| (f, t)))
            .collect();
        let _ = write!(
            o,
            "\n/// Model `{}`, bảng `{}`.\n\
             #[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]\npub struct {} {{\n",
            m.name, m.table, m.name
        );
        for (f, (rust, _)) in &cols {
            let keyword = KEYWORDS.contains(&f.name.as_str());
            if f.column != f.name || keyword {
                let _ = writeln!(o, "    #[sqlx(rename = \"{}\")]", f.column);
            }
            let ident = if keyword {
                format!("r#{}", f.name)
            } else {
                f.name.clone()
            };
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
        server.join("../packages/prisma/prisma/schema.prisma"),
        server.join("crates/trinity-db/src/models.rs"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
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
    fn dung_107_model_va_bo_10_model_luu_tru() {
        let (schema, _) = paths(&server());
        let text = std::fs::read_to_string(schema).expect("đọc schema");
        let (models, _) = parse(&text).expect("đọc");
        let live = models.iter().filter(|m| !ARCHIVED.contains(&m.name.as_str())).count();
        assert_eq!(live, 107);
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
                 @@map(\"a_table\")\n}\nenum E {\n  x\n  y\n}\n";
        let (models, enums) = parse(s).expect("đọc");
        assert_eq!(models[0].table, "a_table");
        let types: Vec<_> = models[0].fields.iter().filter_map(|f| map_type(f, &enums)).collect();
        assert_eq!(
            types,
            [
                ("i32".to_owned(), "int4".to_owned()),
                ("Option<Timestamp>".to_owned(), "timestamptz".to_owned()),
                ("DbDate".to_owned(), "date".to_owned()),
                ("NaiveTimestamp".to_owned(), "timestamp".to_owned()),
                ("String".to_owned(), "text".to_owned()),
                ("Vec<String>".to_owned(), "_text".to_owned()),
            ]
        );
        assert_eq!(models[0].fields[4].column, "col_u");
        assert_eq!(enums[0].values, ["x", "y"]);
    }
}
