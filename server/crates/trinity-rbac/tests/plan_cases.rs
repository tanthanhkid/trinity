//! Bảng ca dùng chung TS ↔ Rust (K25): `server/contracts/cases/plan.json`, cột kết quả do
//! `services/crm/src/common/helpers/plan-cases.spec.ts` sinh từ `@trinity/rbac` và `@trinity/rbac-nest`.

use serde_json::{Value, json};
use trinity_rbac::plan::{
    DEFAULT_OFF_FEATURES, ORG_FEATURES, OrgFeatureKey, PLAN_GATED_FEATURES, PLAN_KEYS, PlanKey, RETIRED_ORG_FEATURE_KEYS,
    apply_plan_to_features, blank_system_features, check_user_slot, require_org_feature, resolve_org_features,
    resolve_plan_for_company,
};

fn table() -> Value {
    let path = format!("{}/../../contracts/cases/plan.json", manifest_dir());
    serde_json::from_str(&std::fs::read_to_string(path).expect("đọc plan.json")).expect("plan.json hợp lệ")
}

fn rows<'a>(t: &'a Value, key: &str) -> &'a Vec<Value> {
    t[key].as_array().unwrap_or_else(|| panic!("thiếu nhóm {key}"))
}

/// `{khoá: bool}` của TS → `OrgFeatures` bằng đường `resolve` (đủ khoá nên không cần mặc định).
fn feats(v: &Value) -> trinity_rbac::plan::OrgFeatures {
    resolve_org_features(v, None)
}

#[test]
fn danh_muc_khoa_nhan_goi_khop_ban_ts() {
    let t = table();
    let f = &t["features"];
    let keys: Vec<Value> = ORG_FEATURES
        .iter()
        .map(|(k, l, g)| json!({"key": k, "label": l, "group": g}))
        .collect();
    assert_eq!(f["keys"], Value::Array(keys));
    assert_eq!(f["default_off"], json!(DEFAULT_OFF_FEATURES));
    assert_eq!(f["plan_gated"], json!(PLAN_GATED_FEATURES));
    assert_eq!(f["retired"], json!(RETIRED_ORG_FEATURE_KEYS));
    assert_eq!(f["blank"], blank_system_features().to_json());

    let plans: Vec<Value> = PLAN_KEYS
        .iter()
        .map(|k| {
            let d = k.def();
            let c = d.channel_limits;
            json!({
                "key": k.as_str(), "label": d.label, "features": d.features, "max_users": d.max_users,
                "channel_limits": {
                    "bulkMessagesPerDay": c.bulk_messages_per_day,
                    "recipientsPerCampaign": c.recipients_per_campaign,
                    "postsPerDay": c.posts_per_day,
                    "autoCommentRepliesPerHour": c.auto_comment_replies_per_hour,
                },
            })
        })
        .collect();
    assert_eq!(t["plans"], Value::Array(plans));
}

#[test]
fn giai_cau_hinh_ap_goi_giai_goi() {
    let t = table();
    let mut n = 0;
    for r in rows(&t, "resolve") {
        let blank = blank_system_features();
        let got = resolve_org_features(&r["raw"], r["blank"].as_bool().unwrap().then_some(&blank)).to_json();
        assert_eq!(got, r["out"], "resolve {r}");
        n += 1;
    }
    for r in rows(&t, "apply") {
        let plan = PlanKey::parse(r["plan"].as_str().unwrap()).unwrap();
        assert_eq!(
            apply_plan_to_features(&feats(&r["features"]), plan).to_json(),
            r["out"],
            "apply {r}"
        );
        n += 1;
    }
    for r in rows(&t, "plan_for_company") {
        let cid = r["company_id"].as_i64().map(|c| i32::try_from(c).unwrap());
        assert_eq!(
            resolve_plan_for_company(r["raw"].as_str(), cid).as_str(),
            r["out"],
            "plan {r}"
        );
        n += 1;
    }
    assert!(n >= 100);
}

#[test]
fn cong_tinh_nang_tra_403_dung_cau_va_han_muc_nguoi() {
    let t = table();
    for r in rows(&t, "gate") {
        let plan = PlanKey::parse(r["plan"].as_str().unwrap()).unwrap();
        let eff = apply_plan_to_features(&resolve_org_features(&r["raw"], None), plan);
        let key = OrgFeatureKey::parse(r["key"].as_str().unwrap()).expect("khoá trong danh mục");
        let got = require_org_feature(&eff, key)
            .err()
            .map(|e| e.to_string());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), r["out"], "gate {r}");
    }
    for r in rows(&t, "slot") {
        let plan = PlanKey::parse(r["plan"].as_str().unwrap()).unwrap();
        let (a, p) = (r["active"].as_u64().unwrap(), r["pending"].as_u64().unwrap());
        let got = check_user_slot(plan, u32::try_from(a).unwrap(), u32::try_from(p).unwrap())
            .err()
            .map(|e| e.to_string());
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), r["out"], "slot {r}");
    }
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
