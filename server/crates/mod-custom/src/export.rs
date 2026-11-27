//! Xuất bản ghi ra CSV hoặc xlsx (chuyển từ `custom-records-export.service.ts`, `csv-format.ts`). Quyền `custom_records.export`.
//! Phạm vi = GIAO của phạm vi XEM và phạm vi XUẤT (không xuất được thứ không xem được). Sắp xếp mới thành cũ (id giảm dần), cắt ở
//! `EXPORT_ROW_CAP` và NÓI RÕ khi cắt (dòng cuối + header). Chống chèn công thức: ô văn bản bắt đầu bằng `= + - @`, tab hoặc CR
//! được thêm dấu `'`; xlsx đi qua bộ ghi chung của docgen (K29) cũng làm sạch như vậy.

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::PgConnection;
use trinity_docgen::xlsx::{Cell, Column, NumFormat, SheetSpec, write_xlsx};
use trinity_kernel::error::AppError;
use trinity_rbac::OwnerIds;

use crate::access::{ObjectDef, load_visible_object};
use crate::dates::{vn_date, vn_date_time};
use crate::present::{Env, present};
use crate::record_query::{RowQuery, query_rows};
use crate::refs::plain;
use crate::types::{FieldDef, Limits};
use crate::{Actor, Ctx, R, forbidden};

const BATCH: i64 = 1000;

/// `csvCell`: chống "CSV injection" và đặt trong ngoặc kép khi có `"`, `,`, xuống dòng.
pub fn csv_cell(v: &Value) -> String {
    let mut s = match v {
        Value::Null => return String::new(),
        other => plain(other),
    };
    if v.is_string() && s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        s = format!("'{s}");
    }
    if s.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

fn titles(rel: Option<&Value>) -> String {
    let Some(rel) = rel else { return String::new() };
    let items: Vec<&Value> = rel.as_array().map_or_else(|| vec![rel], |a| a.iter().collect());
    items
        .iter()
        .map(|x| {
            match (
                x.get("title").and_then(Value::as_str),
                x.get("code").and_then(Value::as_str),
            ) {
                (None, _) => "(không xem được)".to_owned(),
                (Some(t), Some(c)) if !c.is_empty() => format!("{c} {t}"),
                (Some(t), _) => t.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// `exportValue`: nhãn thay vì mã, ngày dd/mm/yyyy, SĐT đã che sẵn bởi `present`.
pub fn export_value(f: &FieldDef, view: &Value) -> Value {
    let Some(v) = view.get("data").and_then(|d| d.get(&f.key)).filter(|v| !v.is_null()) else {
        return Value::String(String::new());
    };
    let label_of = |x: &Value| -> String {
        f.options
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|c| c.get("value") == Some(x)))
            .and_then(|c| c.get("label").and_then(Value::as_str))
            .map_or_else(|| plain(x), str::to_owned)
    };
    match f.kind.as_str() {
        "date" => Value::String(vn_date(&plain(v))),
        "datetime" => Value::String(vn_date_time(&plain(v))),
        "boolean" => Value::String(if v == &Value::Bool(true) { "Có" } else { "Không" }.into()),
        "select" => Value::String(label_of(v)),
        "multi_select" => Value::String(
            v.as_array()
                .map(|a| a.iter().map(label_of).collect::<Vec<_>>().join("; "))
                .unwrap_or_default(),
        ),
        "relation" | "user" | "link" => Value::String(titles(view.get("relations").and_then(|r| r.get(&f.key)))),
        _ => v.clone(),
    }
}

/// Dữ liệu xuất đã gom: tiêu đề cột, các dòng ô, tổng và việc cắt.
pub struct Export {
    pub header: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub total: i64,
    pub exported: i64,
    pub truncated: bool,
}

impl Export {
    pub fn truncated_note(&self) -> String {
        format!(
            "# Đã cắt: chỉ xuất {} bản ghi MỚI NHẤT trong tổng {}. Hãy lọc thu hẹp rồi xuất tiếp.",
            self.exported, self.total
        )
    }

    /// Nội dung CSV: BOM, dòng cách nhau `\r\n`, kết thúc bằng `\r\n`.
    pub fn csv(&self) -> String {
        let mut lines: Vec<String> = vec![
            self.header
                .iter()
                .map(|h| csv_cell(&Value::String(h.clone())))
                .collect::<Vec<_>>()
                .join(","),
        ];
        for r in &self.rows {
            lines.push(r.iter().map(csv_cell).collect::<Vec<_>>().join(","));
        }
        if self.truncated {
            lines.push(csv_cell(&Value::String(self.truncated_note())));
        }
        format!("\u{feff}{}\r\n", lines.join("\r\n"))
    }

    /// Nội dung xlsx: cùng các ô như CSV (chuỗi qua bộ ghi chung nên cũng chống chèn công thức).
    pub fn xlsx(&self, def: &ObjectDef) -> Result<Vec<u8>, AppError> {
        let rows = self
            .rows
            .iter()
            .map(|r| {
                r.iter()
                    .map(|v| match v {
                        Value::Null => Cell::Empty,
                        Value::Number(n) => Cell::Number(n.as_f64().unwrap_or(0.0), NumFormat::General),
                        other => Cell::Text(plain(other)),
                    })
                    .collect()
            })
            .collect();
        write_xlsx(&[SheetSpec {
            name: def.obj.key.clone(),
            title: Some(def.obj.label_plural.clone()),
            subtitle: self.truncated.then(|| self.truncated_note()),
            columns: self.header.iter().map(|h| Column::new(h.clone(), 18.0)).collect(),
            rows,
        }])
        .map_err(AppError::internal)
    }
}

/// Tên tệp: `<khoá>-<yyyymmdd theo giờ Việt Nam>.<đuôi>`.
pub fn filename(def: &ObjectDef, ext: &str) -> String {
    format!(
        "{}-{}.{ext}",
        def.obj.key,
        (Utc::now() + Duration::hours(7)).format("%Y%m%d")
    )
}

/// Phạm vi cần để xuất, lấy TRƯỚC khi giữ kết nối.
pub struct ExportScopes {
    pub env: Env,
    pub export: Option<OwnerIds>,
}

impl ExportScopes {
    pub async fn load(ctx: &Ctx, actor: &Actor) -> R<Self> {
        let export = ctx
            .scopes
            .owner_ids(actor.company, actor.user_id, &actor.grants, "custom_records.export")
            .await
            .map_err(AppError::internal)?;
        Ok(Self {
            env: Env::load(ctx, actor).await?,
            export,
        })
    }
}

/// Gom bản ghi để xuất (route `.../records/export`).
pub async fn collect(
    actor: &Actor,
    conn: &mut PgConnection,
    scopes: &ExportScopes,
    key: &str,
    q: &Value,
) -> R<(ObjectDef, Export)> {
    let (env, exp) = (&scopes.env, scopes.export.clone());
    let def = load_visible_object(conn, actor, key, None).await?;
    let (Some(view), Some(exp)) = (env.owners.record.clone(), exp) else {
        return Err(forbidden("Bạn không có quyền xuất dữ liệu này"));
    };
    let mut header: Vec<String> = vec!["ID".into(), "Mã".into()];
    header.extend(def.fields.iter().map(|f| f.label.clone()));
    header.extend(["Người phụ trách".into(), "Ngày tạo".into(), "Cập nhật lần cuối".into()]);
    let limits = [view, exp];
    let (mut cursor, mut total, mut exported) = (None::<String>, 0i64, 0i64);
    let mut rows: Vec<Vec<Value>> = Vec::new();
    loop {
        let take = BATCH.min(Limits::EXPORT_ROW_CAP - exported);
        let first = cursor.is_none();
        let page = query_rows(
            conn,
            &def,
            &limits,
            &RowQuery {
                q: q.get("q").and_then(Value::as_str).map(str::to_owned),
                limit: take,
                cursor: cursor.clone(),
                offset: 0,
                sort: Some("id".into()),
                desc: true,
                filter: q.get("filter").and_then(Value::as_str).map(str::to_owned),
                with_total: first,
            },
        )
        .await?;
        if let Some(t) = page.total {
            total = t;
        }
        for v in present(conn, actor, &def, &page.rows, env, None).await? {
            let text = |k: &str| v.get(k).cloned().unwrap_or(Value::Null);
            let day = |k: &str| Value::String(vn_date_time(v.get(k).and_then(Value::as_str).unwrap_or_default()));
            let mut cells = vec![
                text("id"),
                Value::String(v.get("code").and_then(Value::as_str).unwrap_or_default().to_owned()),
            ];
            cells.extend(def.fields.iter().map(|f| export_value(f, &v)));
            cells.push(Value::String(
                v.get("owner_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ));
            cells.push(day("created_at"));
            cells.push(day("updated_at"));
            rows.push(cells);
            exported += 1;
        }
        cursor = page.next;
        if cursor.is_none() || exported >= Limits::EXPORT_ROW_CAP {
            break;
        }
    }
    let truncated = total > exported;
    Ok((
        def,
        Export {
            header,
            rows,
            total,
            exported,
            truncated,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use trinity_db::models::CustomObject;
    use trinity_db::types::{PgList, Timestamp};

    fn def() -> ObjectDef {
        let at = Timestamp(Utc::now());
        ObjectDef {
            obj: CustomObject {
                id: 1,
                key: "kh".into(),
                label: "Khách".into(),
                label_plural: "Khách".into(),
                icon: None,
                description: None,
                show_in_nav: true,
                nav_order: 0,
                visible_role_ids: PgList(Vec::new()),
                is_active: true,
                code_prefix: None,
                code_prefix_aliases: PgList(Vec::new()),
                next_code_seq: None,
                created_by: None,
                created_at: at,
                updated_at: at,
                deleted_at: None,
            },
            fields: Vec::new(),
        }
    }

    #[test]
    fn o_csv_chong_chen_cong_thuc() {
        assert_eq!(csv_cell(&json!("=1+1")), "'=1+1");
        assert_eq!(csv_cell(&json!("@SUM(A1)")), "'@SUM(A1)");
        assert_eq!(csv_cell(&json!("-2")), "'-2");
        assert_eq!(csv_cell(&json!(-2)), "-2");
        assert_eq!(csv_cell(&json!("a,b")), "\"a,b\"");
        assert_eq!(csv_cell(&json!("nói \"hi\"")), "\"nói \"\"hi\"\"\"");
        assert_eq!(csv_cell(&json!("=a,b")), "\"'=a,b\"");
        assert_eq!(csv_cell(&Value::Null), "");
        assert_eq!(csv_cell(&json!(1.5)), "1.5");
    }

    #[test]
    fn xlsx_lam_sach_cong_thuc() {
        let e = Export {
            header: vec!["Tên".into()],
            rows: vec![vec![json!("=HYPERLINK(\"x\")")], vec![json!(5)]],
            total: 2,
            exported: 2,
            truncated: false,
        };
        let def = def();
        let bytes = e.xlsx(&def).unwrap();
        let sheet = trinity_docgen::xlsx::read_first_sheet(&bytes).unwrap();
        let cell = sheet.cell(3, 0).as_trimmed_text().unwrap_or_default();
        assert!(cell.starts_with('\''), "{cell}");
    }
}
