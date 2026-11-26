//! K14: bảng route so với `routes.json`, không cần DB.

use axum::http::Method;
use serde_json::{Value, json};
use trinity_http::router::check::{CONTRACT, check, check_embedded, validate_contract};
use trinity_http::router::{Access, RouteSpec};

fn contract() -> Value {
    serde_json::from_str(CONTRACT).unwrap()
}

/// Hai route `can` thật của hợp đồng (một có pipe tham số); route có `org_feature` kiểm riêng ở test bên dưới.
fn good() -> Vec<RouteSpec> {
    vec![
        RouteSpec::new(Method::GET, "/api/v1/api-keys", Access::Can(&["settings.integrations"])).status_ok(200),
        RouteSpec::new(
            Method::GET,
            "/api/v1/api-keys/:id",
            Access::Can(&["settings.integrations"]),
        )
        .status_ok(200)
        .param_pipes(&["param.id:ParseIntPipe"]),
    ]
}

#[test]
fn hop_dong_that_tu_khop_va_bang_dung_khop() {
    let c = contract();
    assert!(validate_contract(&c).is_empty(), "{:?}", validate_contract(&c));
    let rep = check(&good(), &c, false);
    assert!(rep.ok(), "{:?}", rep.problems);
    assert_eq!(rep.declared, 2);
    assert_eq!(rep.contract_total, 571, "583 dòng, health/live/ready lặp 5 lần");
    assert_eq!(rep.missing.len(), 569);
    // Bảng rỗng cũng hợp lệ khi chưa đòi đủ; đòi đủ thì mọi route chưa khai là lỗi.
    assert!(check_embedded(&[], false).ok());
    assert_eq!(check_embedded(&[], true).problems.len(), 571);
}

#[test]
fn lech_tung_cot_deu_bi_bat() {
    let c = contract();
    let one = |s: RouteSpec| check(&[s], &c, false).problems;
    let base = || {
        RouteSpec::new(
            Method::GET,
            "/api/v1/api-keys/:id",
            Access::Can(&["settings.integrations"]),
        )
        .status_ok(200)
        .param_pipes(&["param.id:ParseIntPipe"])
    };
    assert!(one(base()).is_empty());
    let has = |p: Vec<String>, s: &str| assert!(p.iter().any(|l| l.contains(s)), "thiếu `{s}` trong {p:?}");
    has(
        one(RouteSpec::new(Method::GET, "/api/v1/api-keys/:id", Access::AuthOnly)
            .status_ok(200)
            .param_pipes(&["param.id:ParseIntPipe"])),
        "access",
    );
    has(
        one(
            RouteSpec::new(Method::GET, "/api/v1/api-keys/:id", Access::Can(&["users.view"]))
                .status_ok(200)
                .param_pipes(&["param.id:ParseIntPipe"]),
        ),
        "permissions",
    );
    has(
        one(RouteSpec::new(
            Method::GET,
            "/api/v1/api-keys/:id",
            Access::CanAny(&["settings.integrations"]),
        )
        .status_ok(200)
        .param_pipes(&["param.id:ParseIntPipe"])),
        "permission_mode",
    );
    has(one(base().status_ok(201)), "status_ok");
    has(
        one(RouteSpec::new(
            Method::GET,
            "/api/v1/api-keys/:id",
            Access::Can(&["settings.integrations"]),
        )
        .param_pipes(&["param.id:ParseIntPipe"])),
        "status_ok",
    );
    has(one(base().org_feature("zalo_oa")), "org_feature");
    has(one(base().guards(&["ApiKeyGuard"])), "guards");
    has(one(base().param_pipes(&["param.id:ParseInt4Pipe"])), "param_pipes");
    has(
        one(RouteSpec::new(
            Method::GET,
            "/api/v1/api-keys/:id",
            Access::Can(&["settings.integrations"]),
        )
        .status_ok(200)),
        "param_pipes",
    );
    has(
        one(RouteSpec::new(Method::GET, "/api/v1/khong-co", Access::Public)),
        "không có trong routes.json",
    );
    has(check(&[base(), base()], &c, false).problems, "hai lần");
}

#[test]
fn route_co_tinh_nang_to_chuc_them_guard_org_feature() {
    let c = contract();
    let row = c["routes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["org_feature"] == "zalo_oa" && r["method"] == "GET")
        .unwrap();
    let path: &'static str = Box::leak(row["path"].as_str().unwrap().to_owned().into_boxed_str());
    let perms: Vec<&'static str> = row["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| &*Box::leak(p.as_str().unwrap().to_owned().into_boxed_str()))
        .collect();
    let perms: &'static [&'static str] = Box::leak(perms.into_boxed_slice());
    let pipes: Vec<&'static str> = row["param_pipes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| &*Box::leak(p.as_str().unwrap().to_owned().into_boxed_str()))
        .collect();
    let pipes: &'static [&'static str] = Box::leak(pipes.into_boxed_slice());
    let mut s = RouteSpec::new(
        Method::GET,
        path,
        if row["permission_mode"] == "any" {
            Access::CanAny(perms)
        } else if row["access"] == "auth" {
            Access::AuthOnly
        } else {
            Access::Can(perms)
        },
    )
    .param_pipes(pipes)
    .org_feature("zalo_oa");
    if let Some(n) = row["status_ok"].as_u64() {
        s = s.status_ok(n as u16);
    }
    assert!(
        check(&[s.clone()], &c, false).ok(),
        "{:?}",
        check(&[s.clone()], &c, false).problems
    );
    assert_eq!(s.guard_list(), ["OrgFeatureGuard"]);
}

#[test]
fn hop_dong_hong_bi_bat() {
    let mut c = contract();
    c["routes"][0]["permissions"] = json!(["khong.co.quyen"]);
    c["routes"][1]["org_feature"] = json!("khong_co");
    c["routes"][2]["validation"] = json!("sai");
    let p = validate_contract(&c);
    assert!(p.iter().any(|l| l.contains("quyền khong.co.quyen")), "{p:?}");
    assert!(p.iter().any(|l| l.contains("org_feature khong_co")), "{p:?}");
    assert!(p.iter().any(|l| l.contains("validation")), "{p:?}");
}

#[test]
fn duong_dan_axum_doi_dau_hai_cham() {
    let s = RouteSpec::new(Method::GET, "/api/v1/a/:id/b/:cardId", Access::Public);
    assert_eq!(s.axum_path(), "/api/v1/a/{id}/b/{cardId}");
}

#[test]
fn dem_da_khai_chi_tinh_route_khop_va_org_feature_tren_public_bi_chan() {
    let c = contract();
    let mut table = good();
    table.push(RouteSpec::new(Method::GET, "/api/v1/khong-co", Access::Public));
    let rep = check(&table, &c, false);
    assert_eq!(rep.declared, 2, "route không có trong hợp đồng không được đếm");
    assert!(!rep.ok());
    let rep = check(
        &[RouteSpec::new(Method::GET, "/api/v1/live", Access::Public)
            .status_ok(200)
            .org_feature("zalo_oa")],
        &c,
        false,
    );
    assert!(
        rep.problems
            .iter()
            .any(|p| p.contains("org_feature trên route public chưa hỗ trợ")),
        "{:?}",
        rep.problems
    );
}
