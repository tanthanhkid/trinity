//! Xuất danh bạ nền: payload (bộ lọc + phạm vi đã chốt lúc xếp việc) và hàm dựng tệp.

use chrono::Utc;
use mod_contacts::Scopes;
use mod_contacts::export::{export_filename, export_xlsx};
use mod_contacts::filter::ContactFilters;
use serde_json::{Value, json};
use trinity_db::{CompanyRef, Db};
use trinity_rbac::OwnerIds;

use crate::{ExportFile, XLSX_TYPE};

pub const KIND: &str = "contacts";

fn owners_to_json(o: &Option<OwnerIds>) -> Value {
    match o {
        None => Value::Null,
        Some(OwnerIds::All) => json!("all"),
        Some(OwnerIds::Ids(ids)) => json!(ids),
    }
}

fn owners_from_json(v: &Value) -> Result<Option<OwnerIds>, String> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s == "all" => Ok(Some(OwnerIds::All)),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                x.as_i64()
                    .and_then(|n| i32::try_from(n).ok())
                    .ok_or_else(|| format!("phạm vi hỏng: {x}"))
            })
            .collect::<Result<Vec<i32>, String>>()
            .map(|ids| Some(OwnerIds::Ids(ids))),
        other => Err(format!("phạm vi hỏng: {other}")),
    }
}

/// Ghi phạm vi của người gọi vào payload.
pub fn scopes_to_json(s: &Scopes) -> Value {
    json!({
        "view": owners_to_json(&s.view),
        "update": owners_to_json(&s.update),
        "delete": owners_to_json(&s.delete),
        "transfer": owners_to_json(&s.transfer),
        "phone_full": owners_to_json(&s.phone_full),
        "deals_manage": owners_to_json(&s.deals_manage),
    })
}

/// Đọc lại phạm vi; thiếu khoá ⇒ lỗi (không rơi về "mọi dữ liệu").
pub fn scopes_from_json(v: &Value) -> Result<Scopes, String> {
    let get = |k: &str| {
        v.get(k)
            .ok_or_else(|| format!("phạm vi thiếu khoá {k}"))
            .and_then(owners_from_json)
    };
    Ok(Scopes {
        view: get("view")?,
        update: get("update")?,
        delete: get("delete")?,
        transfer: get("transfer")?,
        phone_full: get("phone_full")?,
        deals_manage: get("deals_manage")?,
    })
}

/// Payload của việc `export.run` loại danh bạ.
pub fn payload(export_id: i64, filters: &ContactFilters, scopes: &Scopes) -> Result<Value, serde_json::Error> {
    Ok(json!({
        "export_id": export_id,
        "kind": KIND,
        "filters": serde_json::to_value(filters)?,
        "scopes": scopes_to_json(scopes),
    }))
}

/// Dựng xlsx bằng đúng hàm của `GET /contacts/export` (tệp nền giống tệp trực tiếp).
pub async fn build(db: &Db, company: i32, payload: &Value) -> Result<ExportFile, String> {
    let company = CompanyRef::new(i64::from(company)).map_err(|_| "mã công ty không hợp lệ".to_owned())?;
    let filters: ContactFilters = serde_json::from_value(payload.get("filters").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("bộ lọc hỏng: {e}"))?;
    let scopes = scopes_from_json(payload.get("scopes").unwrap_or(&Value::Null))?;
    let tenant = db.tenant(company).await.map_err(|e| e.to_string())?;
    let mut cn = tenant.acquire().await.map_err(|e| e.to_string())?;
    let data = export_xlsx(&mut cn, &scopes, &filters)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ExportFile {
        filename: export_filename(Utc::now()),
        content_type: XLSX_TYPE,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pham_vi_di_va_ve_nguyen_ven() {
        let s = Scopes {
            view: Some(OwnerIds::All),
            update: Some(OwnerIds::Ids(vec![3, 5])),
            delete: None,
            transfer: Some(OwnerIds::Ids(vec![])),
            phone_full: None,
            deals_manage: Some(OwnerIds::All),
        };
        assert_eq!(scopes_from_json(&scopes_to_json(&s)).unwrap(), s);
    }

    #[test]
    fn pham_vi_thieu_hoac_hong_la_loi_khong_mo_rong() {
        assert!(scopes_from_json(&json!({})).is_err());
        let mut v = scopes_to_json(&Scopes::default());
        v["view"] = json!("everyone");
        assert!(scopes_from_json(&v).is_err());
        v["view"] = json!([1, "a"]);
        assert!(scopes_from_json(&v).is_err());
        v["view"] = json!([5_000_000_000_i64]);
        assert!(scopes_from_json(&v).is_err());
    }

    #[test]
    fn bo_loc_di_va_ve_qua_payload() {
        let f: ContactFilters = serde_json::from_value(json!({
            "source_id": 4, "search": "an", "created_from": "2026-01-01", "lead_label": "hot"
        }))
        .unwrap();
        let p = payload(7, &f, &Scopes::default()).unwrap();
        assert_eq!((p["export_id"].as_i64(), p["kind"].as_str()), (Some(7), Some("contacts")));
        let back: ContactFilters = serde_json::from_value(p["filters"].clone()).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&f).unwrap());
        assert_eq!(back.source_id, Some(4));
        assert_eq!(back.search.as_deref(), Some("an"));
    }
}
