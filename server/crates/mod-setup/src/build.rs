//! "Dựng hệ thống" (`setup-build.service.ts`): chọn loại doanh nghiệp + phân hệ rồi dựng MỘT lần, không cần AI. Lưu tính năng của
//! tổ chức, áp mẫu ngành (bảng + trường + liên kết), kèm vài bản ghi MẪU (tự xoá khi có bản ghi thật đầu tiên), đặt trạng thái đã
//! dựng. Chạy lại được: bảng đã có thì giữ, bản ghi mẫu chỉ sinh khi bảng vừa mới tạo.
//!
//! MỌI bước ghi (bảng, mẫu, phân hệ, ngành, dấu đã dựng, trạng thái) nằm trong MỘT giao dịch: hỏng giữa chừng thì không còn gì dở
//! dang, wizard vẫn ở trạng thái chưa dựng và bấm dựng lại được. Khoá danh sách mẫu lấy ĐẦU giao dịch: việc đọc "đã có mẫu / bản
//! ghi thật chưa" và việc sinh mẫu cùng nằm trong khoá, hai lần dựng đồng thời không sinh mẫu trùng.

use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::can;
use trinity_rbac::plan::{ORG_FEATURES, resolve_org_features};

use crate::industry::{self, industry_keys, is_locked};
use crate::templates::{self, Options};
use crate::{Actor, Ctx, R, bad, db, js_parse_date, now_iso, read_setting, samples, status, write_setting};

/// Ngành đã chọn khi dựng — 1 dòng `settings` (khoá riêng để bước "Chọn ngành" của wizard kiểm thật).
pub const SETUP_INDUSTRY_KEY: &str = "setup_industry";
/// Đã bấm "Dựng hệ thống": `{industry, features, built_at, built_by, samples_seeded}` (JSON).
pub const SETUP_BUILT_KEY: &str = "setup_built";

/// Đầu vào đã qua kiểm dữ liệu.
#[derive(Debug, Clone)]
pub struct BuildInput {
    pub industry: String,
    /// Phân hệ muốn dùng; vắng = bộ gợi ý của ngành. Bộ cơ bản luôn bật.
    pub features: Option<Vec<String>>,
}

impl BuildInput {
    pub fn from_validated(v: &Value) -> Self {
        Self {
            industry: v.get("industry").and_then(Value::as_str).unwrap_or_default().to_owned(),
            features: v
                .get("features")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
        }
    }
}

/// Đã dựng: `setup_built` (bấm "Dựng"), hoặc `setup_status` ĐÃ GHI là da_dung/dang_dung (luồng AI cũ). Hệ thống đang đi qua wizard
/// (`chua_dung`) chỉ dựa vào hai dấu trên. Thiếu dòng `setup_status` (bản cài rất cũ): có bảng tuỳ biến hoặc dữ liệu THẬT
/// (mẫu không tính) ⇒ đã dựng.
pub async fn is_built(conn: &mut PgConnection) -> R<bool> {
    if read_setting(conn, SETUP_BUILT_KEY).await?.is_some() {
        return Ok(true);
    }
    let st = read_setting(conn, status::SETUP_STATUS_KEY).await?;
    match st.as_deref().map(trinity_kernel::vi::trim_js) {
        Some("da_dung" | "dang_dung") => return Ok(true),
        Some("chua_dung") => return Ok(false),
        _ => {}
    }
    let obj: Option<i32> =
        sqlx::query_scalar("SELECT id FROM custom_objects WHERE deleted_at IS NULL AND is_active LIMIT 1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    if obj.is_some() {
        return Ok(true);
    }
    let sample = samples::read(conn).await?;
    samples::has_real(conn, sample.as_ref()).await
}

struct Plan {
    features: Vec<&'static str>,
    first_built_at: Option<String>,
    seeded: bool,
}

/// Phân hệ sẽ bật khi dựng (+ `built_at` lần đầu nếu đã dựng): dựng lại không truyền `features` thì GIỮ cấu hình đang lưu.
async fn plan(conn: &mut PgConnection, ind: &'static crate::catalog::Industry, chosen: Option<&[String]>) -> R<Plan> {
    let prev = read_setting(conn, SETUP_BUILT_KEY).await?;
    let parsed: Option<Value> = prev.as_deref().and_then(|s| serde_json::from_str(s).ok());
    let first_built_at = parsed
        .as_ref()
        .and_then(|j| j.get("built_at"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let seeded = parsed
        .as_ref()
        .and_then(|j| j.get("samples_seeded"))
        .and_then(Value::as_bool)
        == Some(true);
    if chosen.is_none() && prev.is_some() {
        let raw: Value = read_setting(conn, "org_features")
            .await?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        let kept = resolve_org_features(&raw, None);
        let features = ORG_FEATURES
            .iter()
            .map(|(k, _, _)| *k)
            .filter(|k| kept.get(k) == Some(true) || is_locked(k))
            .collect();
        return Ok(Plan {
            features,
            first_built_at,
            seeded,
        });
    }
    Ok(Plan {
        features: industry::resolve_build_features(ind, chosen),
        first_built_at,
        seeded,
    })
}

/// `JSON.stringify` theo thứ tự `ORG_FEATURE_KEYS`.
fn features_json(on: &[&str]) -> String {
    let body = ORG_FEATURES
        .iter()
        .map(|(k, _, _)| format!("\"{k}\":{}", on.contains(k)))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

pub async fn build(ctx: &Ctx, actor: &Actor, input: &BuildInput) -> R<Value> {
    if !can(&actor.grants, "custom_objects.manage", None) || !can(&actor.grants, "settings.features", None) {
        return Err(HttpError::forbidden(
            "Dựng hệ thống cần quyền quản trị (quản lý tính năng tuỳ biến và tính năng của công ty).",
        )
        .into());
    }
    let Some(ind) = industry::find(&input.industry) else {
        return Err(bad(format!(
            "Loại doanh nghiệp không hợp lệ. Chọn một trong: {}.",
            industry_keys().join(", ")
        )));
    };
    let may_seed = can(&actor.grants, "custom_records.manage", None);
    let mut tx = ctx.begin(actor.company).await?;
    samples::lock(&mut tx).await?;
    let plan = plan(&mut tx, ind, input.features.as_deref()).await?;
    // Mẫu chỉ sinh khi công ty CHƯA có dữ liệu thật (dựng lại trên hệ thống đang chạy không chèn dữ liệu giả vào lẫn).
    let want_samples = !plan.seeded && may_seed && {
        let cur = samples::read(&mut tx).await?;
        !samples::has_real(&mut tx, cur.as_ref()).await?
    };
    let built_at = plan
        .first_built_at
        .clone()
        .filter(|s| js_parse_date(s).is_some())
        .unwrap_or_else(now_iso);

    let mut created: Vec<String> = Vec::new();
    let mut existing: Vec<String> = Vec::new();
    let (mut sample_records, mut sample_contacts) = (0_usize, 0_usize);
    if let Some(tpl) = ind.template.as_deref().and_then(crate::catalog::find_template) {
        for o in &tpl.objects {
            templates::assert_template_valid(o)?;
        }
        let r = templates::apply_in_tx(
            &mut tx,
            actor,
            tpl,
            want_samples,
            Options {
                sample_objects: Some(1),
                track_samples: true,
            },
        )
        .await?;
        created = r.created;
        existing = r.existing;
        sample_records = r.sample_records;
    } else if want_samples && samples::read(&mut tx).await?.is_none() {
        sample_contacts = samples::seed_contacts(&mut tx, actor.user_id).await?.len();
    }
    let seeded = plan.seeded || sample_records + sample_contacts > 0;
    write_setting(
        &mut tx,
        "org_features",
        &features_json(&plan.features),
        Some(actor.user_id),
    )
    .await?;
    write_setting(&mut tx, SETUP_INDUSTRY_KEY, &ind.key, Some(actor.user_id)).await?;
    let built = format!(
        "{{\"industry\":{},\"features\":{},\"built_at\":{},\"built_by\":{},\"samples_seeded\":{seeded}}}",
        json!(ind.key),
        json!(plan.features),
        json!(built_at),
        actor.user_id
    );
    write_setting(&mut tx, SETUP_BUILT_KEY, &built, Some(actor.user_id)).await?;
    status::set(&mut tx, "da_dung", Some(actor.user_id)).await?;
    tx.commit().await.map_err(AppError::internal)?;
    if sample_contacts > 0
        && let Some(f) = &ctx.contacts_changed
    {
        f(actor.company);
    }
    tracing::info!(
        "dựng hệ thống: ngành {}, {} phân hệ, bảng mới {:?}, mẫu {}",
        ind.key,
        plan.features.len(),
        created,
        sample_records + sample_contacts
    );
    Ok(json!({
        "industry": ind.key, "features": plan.features, "created_objects": created, "existing_objects": existing,
        "sample_records": sample_records, "sample_contacts": sample_contacts, "setup_status": "da_dung",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_phan_he_dung_thu_tu() {
        let s = features_json(&["dashboard", "pos"]);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["dashboard"], true);
        assert_eq!(v["pos"], true);
        assert_eq!(v["inbox"], false);
        assert!(s.starts_with("{\"dashboard\":true,"));
        assert_eq!(v.as_object().unwrap().len(), ORG_FEATURES.len());
    }
}
