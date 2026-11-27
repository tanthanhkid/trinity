//! Đối chiếu bản Rust với MÃ NODE THẬT: `fixtures/records.json` do `custom-records-golden.spec.ts` sinh (chuẩn hoá giá trị bản
//! ghi, công thức, ô CSV, giá trị xuất, tiêu đề, thẻ @, tham chiếu, mã, con trỏ, ngày). Không cần Postgres.

use mod_custom::dates::{vn_date, vn_date_time};
use mod_custom::export::{csv_cell, export_value};
use mod_custom::present::compute_formulas;
use mod_custom::record_query::{Cursor, decode_cursor, encode_cursor};
use mod_custom::record_values::{normalize_value, number_value};
use mod_custom::records::title_of;
use mod_custom::refs::{extract_mention_codes, format_code, parse_code, parse_ref};
use mod_custom::types::FieldDef;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/records.json")).expect("records.json hợp lệ")
}

fn field(f: &Value) -> FieldDef {
    FieldDef {
        id: 1,
        key: f.get("key").and_then(Value::as_str).unwrap_or("k").to_owned(),
        label: f["label"].as_str().unwrap().to_owned(),
        kind: f["type"].as_str().unwrap().to_owned(),
        required: false,
        is_unique: false,
        is_title: f.get("is_title").and_then(Value::as_bool).unwrap_or(false),
        show_in_list: true,
        sort_order: 0,
        options: f["options"].clone(),
        help_text: None,
    }
}

fn items<'a>(g: &'a Value, k: &str) -> &'a Vec<Value> {
    g[k].as_array().unwrap_or_else(|| panic!("thiếu {k}"))
}

#[test]
fn chuan_hoa_gia_tri_khop_node() {
    let g = golden();
    for c in items(&g, "values") {
        let f = field(&c["field"]);
        let got = normalize_value(&f, &c["raw"]);
        let ctx = format!("{} {}", f.kind, c["raw"]);
        match (&c["result"]["ok"], &c["result"]["error"]) {
            (ok, Value::Null) => assert_eq!(
                got.unwrap_or_else(|e| panic!("{ctx}: lỗi {}", e.0))
                    .unwrap_or(Value::Null),
                *ok,
                "{ctx}"
            ),
            (_, err) => assert_eq!(got.expect_err(&ctx).0, err.as_str().unwrap(), "{ctx}"),
        }
    }
}

#[test]
fn cong_thuc_ban_ghi_khop_node() {
    let g = golden();
    let fields = formula_fields();
    for c in items(&g, "formulas") {
        let data = c["data"].as_object().cloned().unwrap_or_default();
        let got = compute_formulas(&fields, &data);
        let want = c["result"].as_object().unwrap();
        assert_eq!(got.len(), want.len(), "bộ khoá {data:?}");
        for (k, w) in want {
            let v = got.get(k).copied().flatten().map_or(Value::Null, number_value);
            assert_eq!(&v, w, "{k} với {data:?}");
        }
    }
}

fn formula_fields() -> Vec<FieldDef> {
    let f = |key: &str, ty: &str, expr: Option<&str>| {
        let mut d = field(&json!({ "key": key, "label": key, "type": ty, "options": {} }));
        if let Some(e) = expr {
            d.options = json!({ "expression": e });
        }
        d
    };
    vec![
        f("gia", "currency", None),
        f("pt", "percent", None),
        f("sl", "number", None),
        f("ngay", "date", None),
        f("gio", "datetime", None),
        f("ten", "text", None),
        f("a", "formula", Some("{gia}*2+{pt}")),
        f("b", "formula", Some("{gia}/{sl}")),
        f("c", "formula", Some("{gia}*{pt}")),
        f("d", "formula", Some("DAYS({ngay}, TODAY())")),
        f("e", "formula", Some("{khong_co}")),
        f("f", "formula", Some("(")),
        f("g", "formula", None),
        f("h", "formula", Some("{ten}")),
        f("i", "formula", Some("{a}+1")),
        f("j", "formula", Some("ROUND({sl}/3, 2)")),
    ]
}

#[test]
fn o_csv_va_gia_tri_xuat_khop_node() {
    let g = golden();
    for c in items(&g, "csv_cells") {
        assert_eq!(csv_cell(&c["value"]), c["cell"].as_str().unwrap(), "{}", c["value"]);
    }
    for c in items(&g, "export_values") {
        let f = field(&c["field"]);
        let view = json!({ "data": c["data"], "relations": c["relations"] });
        assert_eq!(export_value(&f, &view), c["result"], "{} {}", f.kind, c["data"]);
    }
    for c in items(&g, "dates") {
        let raw = c["raw"].as_str().unwrap();
        assert_eq!(vn_date(raw), c["date"].as_str().unwrap(), "vnDate {raw}");
        assert_eq!(vn_date_time(raw), c["datetime"].as_str().unwrap(), "vnDateTime {raw}");
    }
}

#[test]
fn tieu_de_the_ma_tham_chieu_khop_node() {
    let g = golden();
    for c in items(&g, "titles") {
        let is_title = c["value"] != json!("(không có trường tiêu đề)");
        let mut data = Map::new();
        if c["value"] != json!("(không có trường tiêu đề)") {
            data.insert("t".into(), c["value"].clone());
        } else {
            data.insert("t".into(), json!("x"));
        }
        let def = def_with_title(is_title);
        assert_eq!(json!(title_of(&def, &data)), c["title"], "{}", c["value"]);
    }
    for c in items(&g, "mentions") {
        let max = usize::try_from(c["max"].as_u64().unwrap()).unwrap();
        assert_eq!(
            json!(extract_mention_codes(c["text"].as_str().unwrap(), max)),
            c["codes"],
            "{}",
            c["text"]
        );
    }
    for c in items(&g, "refs") {
        let got = c["raw"]
            .as_str()
            .and_then(parse_ref)
            .map_or(Value::Null, |r| json!({ "type": r.ty.as_str(), "id": r.id }));
        assert_eq!(got, c["ref"], "{}", c["raw"]);
    }
    for c in items(&g, "codes") {
        let got = parse_code(c["raw"].as_str().unwrap()).map_or(
            Value::Null,
            |p| json!({ "prefix": p.prefix, "seq": p.seq, "code": p.code }),
        );
        assert_eq!(got, c["parsed"], "{}", c["raw"]);
    }
    for c in items(&g, "formats") {
        assert_eq!(
            format_code(c["prefix"].as_str().unwrap(), c["seq"].as_i64().unwrap()),
            c["code"].as_str().unwrap()
        );
    }
}

fn def_with_title(is_title: bool) -> mod_custom::access::ObjectDef {
    use trinity_db::models::CustomObject;
    use trinity_db::types::{PgList, Timestamp};
    let at = Timestamp(chrono::Utc::now());
    mod_custom::access::ObjectDef {
        obj: CustomObject {
            id: 1,
            key: "k".into(),
            label: "K".into(),
            label_plural: "K".into(),
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
        fields: vec![field(
            &json!({ "key": "t", "label": "T", "type": "text", "options": {}, "is_title": is_title }),
        )],
    }
}

#[test]
fn con_tro_khop_node() {
    let g = golden();
    for c in items(&g, "cursors") {
        let cur = Cursor {
            v: c["cursor"]["v"].as_str().map(str::to_owned),
            id: c["cursor"]["id"].as_i64().unwrap(),
        };
        assert_eq!(encode_cursor(&cur), c["encoded"].as_str().unwrap());
        assert_eq!(decode_cursor(&encode_cursor(&cur)).unwrap(), cur);
    }
    for c in items(&g, "cursor_raw") {
        let raw = c["raw"].as_str().unwrap();
        match (&c["result"]["ok"], decode_cursor(raw)) {
            (Value::Null, Err(e)) => assert!(
                e.to_string().contains(c["result"]["error"].as_str().unwrap()),
                "{raw}: {e}"
            ),
            (ok, Ok(cur)) => assert_eq!(json!({ "v": cur.v, "id": cur.id }), *ok, "{raw}"),
            (ok, Err(e)) => panic!("{raw}: Node ra {ok}, Rust lỗi {e}"),
        }
    }
}
