//! Job chạy theo tên qua API điều khiển test (chỉ build `--features test-hooks`, K34). Tên và hình dạng kết quả theo bản Node
//! (C18) để bộ hợp đồng `tests/contract` dùng được: `lead-scoring`, `webhook-dispatch`, `ai-action-expiry`,
//! `notification.reap-stuck`, `briefings.collect`.
//!
//! Khác job nền thật: chạy BẤT KỂ cờ env của module (job nền bị tắt khi API điều khiển test bật, xem `mod_leads::jobs`), nên ca
//! test không phải bật cờ rồi chờ lịch. Riêng `webhook-dispatch` vẫn tôn trọng `INTEGRATIONS_WEBHOOKS_ENABLED` (trả `skipped`).

use std::sync::Arc;

use serde_json::{Value, json};
use trinity_db::Db;
use trinity_integrations::webhooks::dispatcher::Dispatcher;
use trinity_testhooks::{HooksError, TestHooks};

fn s(e: impl std::fmt::Debug) -> String {
    format!("{e:?}")
}

pub fn register(
    hooks: TestHooks,
    db: Db,
    webhooks: Option<(Arc<Dispatcher>, bool)>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<TestHooks, HooksError> {
    let multi_tenant = db.multi_tenant();
    let _ = get;
    let (d_lead, d_ai, d_notify, d_brief, d_wh) = (db.clone(), db.clone(), db.clone(), db.clone(), db);

    let hooks = hooks
        .plain_job("lead-scoring", move |company, _body| {
            let db = d_lead.clone();
            async move {
                let features = crate::job_ports::CompanyFeatures { company, multi_tenant };
                let tenant = db.tenant(company).await.map_err(s)?;
                let mut conn = tenant.acquire().await.map_err(s)?;
                match mod_leads::lead::run_once(&mut conn, &features, chrono::Utc::now())
                    .await
                    .map_err(s)?
                {
                    mod_leads::lead::RunOutcome::Skipped(why) => Ok(json!({ "skipped": why })),
                    mod_leads::lead::RunOutcome::Ran(_) => Ok(json!({ "skipped": null })),
                }
            }
        })
        .plain_job("webhook-dispatch", move |company, _body| {
            let (db, wh) = (d_wh.clone(), webhooks.clone());
            async move {
                let Some((dispatcher, on)) = wh else {
                    return Ok(json!({ "skipped": "dispatcher chưa dựng" }));
                };
                if !on {
                    return Ok(json!({ "skipped": "INTEGRATIONS_WEBHOOKS_ENABLED chưa bật" }));
                }
                let tenant = db.tenant(company).await.map_err(s)?;
                dispatcher.tick(&tenant, true).await.map_err(s)?;
                Ok(json!({ "skipped": null }))
            }
        })
        .timed_job("ai-action-expiry", move |company, now, _body| {
            let db = d_ai.clone();
            async move {
                let mut conn = db.tenant(company).await.map_err(s)?.acquire().await.map_err(s)?;
                let r = mod_ai_actions::service::expire_overdue(&mut conn, now)
                    .await
                    .map_err(s)?;
                Ok(json!({ "expired": r.expired, "stale": r.stale, "purged": r.purged }))
            }
        })?
        .timed_job("notification.reap-stuck", move |company, now, _body| {
            let db = d_notify.clone();
            async move {
                let tenant = db.tenant(company).await.map_err(s)?;
                let (requeued, failed) = mod_notify::notifications::reap_stuck_processing(&tenant, now)
                    .await
                    .map_err(s)?;
                Ok(json!({ "requeued": requeued, "failed": failed }))
            }
        })?
        .timed_job("briefings.collect", move |company, now, body| {
            let db = d_brief.clone();
            async move {
                let owners = match body.get("owner") {
                    None | Some(Value::Null) => mod_briefings::types::Owners::All,
                    Some(Value::Array(v)) => mod_briefings::types::Owners::Users(
                        v.iter()
                            .map(|x| {
                                x.as_i64()
                                    .and_then(|n| i32::try_from(n).ok())
                                    .ok_or("owner phải là mảng số nguyên")
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                    Some(_) => return Err("owner phải là mảng số nguyên".to_owned()),
                };
                let slot = match body.get("slot").and_then(Value::as_str) {
                    Some("morning") | None => mod_briefings::types::Slot::Morning,
                    Some("evening") => mod_briefings::types::Slot::Evening,
                    Some(_) => return Err("slot phải là morning hoặc evening".to_owned()),
                };
                let mut conn = db.tenant(company).await.map_err(s)?.acquire().await.map_err(s)?;
                let data = mod_briefings::aggregate::collect(&mut conn, &owners, slot, now)
                    .await
                    .map_err(s)?;
                serde_json::to_value(data).map_err(s)
            }
        })?;
    Ok(hooks)
}
