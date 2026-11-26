use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};

use super::*;

const SECRET: &str = "svc-secret";

fn auth() -> Arc<Authenticator> {
    // Db lười: các ca này không chạm Postgres (chỉ kiểm `x-service-secret`).
    let db = Db::connect_lazy(&DbConfig::new("postgresql://u@127.0.0.1:1/none")).unwrap();
    let platform = Platform::new(&db, None);
    Arc::new(Authenticator::new(
        Security::new(db, platform, false),
        "jwt-secret",
        &[SECRET],
    ))
}

fn companies() -> CompanyFn {
    Arc::new(|id| Box::pin(async move { (id == 1 || id == 2).then(|| CompanyRef::new(id).unwrap()) }))
}

fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
    move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
}

const ON: &[(&str, &str)] = &[("TRINITY_TEST_HOOKS", "1"), ("NODE_ENV", "test")];

struct Fixture {
    router: Router,
    flushed: Arc<AtomicUsize>,
    seen_now: Arc<std::sync::Mutex<Vec<(i32, String)>>>,
}

fn fixture(multi: bool) -> Fixture {
    let flushed = Arc::new(AtomicUsize::new(0));
    let seen_now = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (f2, s2) = (flushed.clone(), seen_now.clone());
    let hooks = TestHooks::with_company_lookup(auth(), companies(), multi)
        .timed_job("notification.reap-stuck", move |c, now, _| {
            let s2 = s2.clone();
            async move {
                s2.lock().unwrap().push((c.id(), now.to_rfc3339()));
                Ok(json!({"requeued": 1, "failed": 0}))
            }
        })
        .unwrap()
        .on_flush(move || {
            f2.fetch_add(1, Ordering::SeqCst);
        });
    Fixture {
        router: hooks.router(env(ON)).expect("bật"),
        flushed,
        seen_now,
    }
}

async fn call(r: &Router, path: &str, secret: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::post(path);
    if let Some(s) = secret {
        req = req.header("x-service-secret", s);
    }
    let body = body.map_or(Body::empty(), |b| {
        req = std::mem::replace(&mut req, Request::post("/")).header("content-type", "application/json");
        Body::from(b.to_string())
    });
    // `req` được dựng lại ở trên khi có body; dựng request cuối.
    let res = r.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn production_hoac_thieu_co_thi_khong_co_route() {
    for pairs in [
        &[("TRINITY_TEST_HOOKS", "1"), ("NODE_ENV", "production")][..],
        &[("TRINITY_TEST_HOOKS", "1")][..],
        &[("NODE_ENV", "test")][..],
    ] {
        let hooks = TestHooks::with_company_lookup(auth(), companies(), false);
        let pairs: &'static [(&'static str, &'static str)] = Box::leak(pairs.to_vec().into_boxed_slice());
        assert!(hooks.router(env(pairs)).is_none(), "{pairs:?}");
    }
}

#[tokio::test]
async fn can_service_secret() {
    let f = fixture(false);
    let (s, _) = call(&f.router, "/internal/test/cache/flush", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call(&f.router, "/internal/test/cache/flush", Some("sai"), None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = call(
        &f.router,
        "/internal/test/jobs/notification.reap-stuck/run",
        None,
        Some(json!({})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn flush_goi_moi_bo_xoa() {
    let f = fixture(false);
    let (s, b) = call(&f.router, "/internal/test/cache/flush", Some(SECRET), None).await;
    assert_eq!((s, b["flushed"].as_i64()), (StatusCode::OK, Some(1)));
    assert_eq!(f.flushed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn chay_job_theo_ten_voi_now_co_dinh() {
    let f = fixture(false);
    let (s, b) = call(
        &f.router,
        "/internal/test/jobs/notification.reap-stuck/run",
        Some(SECRET),
        Some(json!({"now": "2026-01-01T09:00:00+07:00"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{b}");
    assert_eq!(
        b,
        json!({"job": "notification.reap-stuck", "result": {"requeued": 1, "failed": 0}})
    );
    assert_eq!(
        f.seen_now.lock().unwrap().as_slice(),
        [(1, "2026-01-01T02:00:00+00:00".to_owned())]
    );
}

#[tokio::test]
async fn now_sai_cho_hoac_sai_dinh_dang_la_400() {
    let f = fixture(false);
    let run = |body: Value| {
        call(
            &f.router,
            "/internal/test/jobs/notification.reap-stuck/run",
            Some(SECRET),
            Some(body),
        )
    };
    assert_eq!(
        run(json!({"now": "2026-01-01T00:00:00"})).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(run(json!({"now": "abc"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(run(json!({"now": 5})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(
            &f.router,
            "/internal/test/jobs/khong-co/run",
            Some(SECRET),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn company_id_theo_che_do() {
    let single = fixture(false);
    let p = "/internal/test/jobs/notification.reap-stuck/run";
    assert_eq!(
        call(&single.router, p, Some(SECRET), Some(json!({}))).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&single.router, p, Some(SECRET), Some(json!({"company_id": 2})))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let multi = fixture(true);
    assert_eq!(
        call(&multi.router, p, Some(SECRET), Some(json!({}))).await.0,
        StatusCode::BAD_REQUEST
    );
    for bad in [json!(0), json!(-3), json!("2"), json!(99)] {
        assert_eq!(
            call(&multi.router, p, Some(SECRET), Some(json!({"company_id": bad})))
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    let (s, _) = call(&multi.router, p, Some(SECRET), Some(json!({"company_id": 2}))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(multi.seen_now.lock().unwrap()[0].0, 2);
}

#[tokio::test]
async fn timed_job_chi_nhan_hai_viec_cua_c18() {
    let h = TestHooks::with_company_lookup(auth(), companies(), false);
    assert!(h.timed_job("stale-work", |_, _, _| async { Ok(Value::Null) }).is_err());
}

#[tokio::test]
async fn chay_job_cua_scheduler_theo_ten_cho_mot_cong_ty() {
    use std::time::Duration;
    use trinity_jobs::{JobSpec, Scheduler};
    let db = Db::connect_lazy(&DbConfig::new("postgresql://u@127.0.0.1:1/none")).unwrap();
    let platform = Platform::new(&db, None);
    let sched = Scheduler::new(&db, &platform, trinity_kernel::ownership::Ownership::default(), "test");
    let ran = Arc::new(std::sync::Mutex::new(Vec::new()));
    let r2 = ran.clone();
    sched.register(
        JobSpec::new(
            "stale-work",
            Duration::from_secs(60),
            Duration::from_secs(10),
            move |c| {
                let r2 = r2.clone();
                async move {
                    r2.lock().unwrap().push(c.id());
                    Ok(())
                }
            },
        )
        .unwrap(),
    );
    let hooks = TestHooks::with_company_lookup(auth(), companies(), true).scheduler(sched);
    let router = hooks.router(env(ON)).unwrap();
    let p = "/internal/test/jobs/stale-work/run";
    let (s, b) = call(&router, p, Some(SECRET), Some(json!({"company_id": 2}))).await;
    assert_eq!((s, b["job"].as_str()), (StatusCode::OK, Some("stale-work")));
    assert_eq!(ran.lock().unwrap().as_slice(), [2]);
    // `now` không nhận cho job ngoài hai việc của C18.
    let (s, _) = call(
        &router,
        p,
        Some(SECRET),
        Some(json!({"company_id": 2, "now": "2026-01-01T00:00:00Z"})),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(ran.lock().unwrap().len(), 1);
}
