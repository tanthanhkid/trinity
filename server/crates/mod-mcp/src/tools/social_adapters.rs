//! Bộ chuyển (adapter) từ dịch vụ `mod_social` thật (M54a/M55b) sang các cổng của tool đăng bài: [`RecurrencePort`] (bài lặp) và
//! [`ImportPort`] (nhập nhiều bài). Cùng một [`SocialAdapter`] dùng cho cả hai cổng.
//!
//! Cũng bọc [`MetricsPort`] (`mod_social::stats`, lấy số một bài qua `Runner` của job M54b) và [`DraftPublishPort`]
//! (`mod_social::draft_publish`, kick `Runner` khi bài không hẹn giờ).
//!
//! Mỗi lời gọi tự xin kết nối ngắn của mình, không giữ kết nối khi gọi chỗ khác.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use mod_facebook::config::Env;
use mod_social::adapters::{DraftsAdapter, PostsAdapter, QueueAdapter};
use mod_social::dto::DraftPublish;
use mod_social::dto_recur::RecurrenceBody;
use mod_social::import::{self, ImportMode, ImportPorts, StructuredRow};
use mod_social::jobs::Runner;
use mod_social::media::{self, MediaCtx, MediaStore};
use mod_social::posts::PostCtx;
use mod_social::{accounts, draft_publish, recurrences, stats};
use serde::Serialize;
use serde_json::{Value, json};
use trinity_db::{CompanyRef, Db, TenantDb};
use trinity_kernel::error::{AppError, HttpError};

use super::social_ports::{
    DraftOverrides, DraftPublishPort, ImportPort, MetricsPort, PortFut, PostInfra, RecurrencePort, RefreshReport,
};

pub struct SocialAdapter {
    pub db: Db,
    pub env: Env,
    pub store: MediaStore,
    pub infra: PostInfra,
    pub runner: Arc<Runner>,
}

impl SocialAdapter {
    pub fn new(db: Db, env: Env, store: MediaStore, infra: PostInfra, runner: Arc<Runner>) -> Arc<Self> {
        Arc::new(Self {
            db,
            env,
            store,
            infra,
            runner,
        })
    }

    async fn tenant(&self, company: CompanyRef) -> Result<TenantDb, AppError> {
        self.db.tenant(company).await.map_err(AppError::internal)
    }
}

/// Struct Serialize → `Value` (không dùng `to_value`: lint `json-value`).
fn js<T: Serialize>(t: &T) -> Result<Value, AppError> {
    let s = serde_json::to_string(t).map_err(AppError::internal)?;
    serde_json::from_str(&s).map_err(AppError::internal)
}

fn bad(m: &str) -> AppError {
    HttpError::bad_request(m).into()
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn mode_of(mode: &str) -> Result<ImportMode, AppError> {
    match mode {
        "drafts" => Ok(ImportMode::Drafts),
        "schedule" => Ok(ImportMode::Schedule),
        _ => Err(bad("mode phải là drafts hoặc schedule.")),
    }
}

/// Dòng đã chuẩn hoá của tool (`normalize_rows`) → `StructuredRow`.
fn rows_of(rows: &Value) -> Vec<StructuredRow> {
    let text = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
    rows.as_array()
        .map(|list| {
            list.iter()
                .map(|r| StructuredRow {
                    content: text(r, "content"),
                    account_ids: r
                        .get("account_ids")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_i64)
                                .filter_map(|n| i32::try_from(n).ok())
                                .collect()
                        })
                        .unwrap_or_default(),
                    scheduled_at: text(r, "scheduled_at"),
                    use_queue: r.get("use_queue").and_then(Value::as_bool).unwrap_or(false),
                    media_keys: r
                        .get("media_keys")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                        .unwrap_or_default(),
                    first_comment: text(r, "first_comment"),
                    utm_campaign: text(r, "utm_campaign"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Dựng `PostsAdapter` của công ty trên các biến cục bộ (`graph` phải sống đủ lâu).
macro_rules! with_posts {
    ($s:expr, $company:expr, $graph:ident, $posts:ident, $body:block) => {{
        let $graph = ($s.infra.graph_for)($company);
        let $posts = PostsAdapter {
            db: &$s.db,
            company: $company,
            env: &$s.env,
            store: &$s.store,
            graph: &$graph,
            guard: &$s.infra.guard,
            now_ms: now_ms(),
        };
        $body
    }};
}

impl RecurrencePort for SocialAdapter {
    fn list(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>> {
        Box::pin(async move {
            let tdb = self.tenant(company).await?;
            let list = recurrences::list(&tdb, Utc::now()).await?;
            list.iter().map(js).collect()
        })
    }

    fn get(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value> {
        Box::pin(async move {
            let tdb = self.tenant(company).await?;
            js(&recurrences::get(&tdb, id, Utc::now()).await?)
        })
    }

    fn preview(&self, company: CompanyRef, user_id: i32, input: Value, id: Option<i32>) -> PortFut<'_, Value> {
        Box::pin(async move {
            let body = RecurrenceBody::from_json(&input).map_err(AppError::from)?;
            let tdb = self.tenant(company).await?;
            let p = with_posts!(self, company, graph, posts, {
                recurrences::preview(&tdb, &posts, user_id, &body, id, Utc::now()).await?
            });
            let n = &p.normalized;
            let names: Vec<(i32, String, String)> = {
                let mut conn = tdb.acquire().await.map_err(AppError::internal)?;
                accounts::list(&mut conn)
                    .await?
                    .into_iter()
                    .map(|a| (a.id, a.name, a.network))
                    .collect()
            };
            let targets: Vec<Value> = n
                .template
                .targets
                .iter()
                .map(|t| {
                    let (name, network) = names
                        .iter()
                        .find(|(i, _, _)| *i == t.account_id)
                        .map(|(_, n, w)| (n.clone(), w.clone()))
                        .unwrap_or_default();
                    json!({
                        "account_id": t.account_id,
                        "account_name": name,
                        "network": network,
                        "caption": t.caption,
                        "options": t.options,
                    })
                })
                .collect();
            let media_ctx = MediaCtx {
                db: &self.db,
                company,
                store: &self.store,
                env: &self.env,
                user_id,
                now_ms: now_ms(),
            };
            let media: Vec<Value> = media::resolve(&media_ctx, &n.template.media_keys)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|m| json!({ "type": m.r#type }))
                .collect();
            Ok(json!({
                "title": n.title,
                "rule": js(&n.rule)?,
                "startsOn": n.starts_on,
                "endsOn": n.ends_on,
                "maxCount": n.max_count,
                "times": js(&p.times)?,
                "validated": { "content": n.template.content, "targets": targets, "media": media },
            }))
        })
    }

    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> PortFut<'_, Value> {
        Box::pin(async move {
            let body = RecurrenceBody::from_json(&input).map_err(AppError::from)?;
            let tdb = self.tenant(company).await?;
            let v = with_posts!(self, company, graph, posts, {
                recurrences::create(&tdb, &posts, user_id, &body, Utc::now()).await?
            });
            js(&v)
        })
    }

    fn update(&self, company: CompanyRef, user_id: i32, id: i32, input: Value) -> PortFut<'_, Value> {
        Box::pin(async move {
            let body = RecurrenceBody::from_json(&input).map_err(AppError::from)?;
            let tdb = self.tenant(company).await?;
            let v = with_posts!(self, company, graph, posts, {
                recurrences::update(&tdb, &posts, user_id, id, &body, Utc::now()).await?
            });
            js(&v)
        })
    }

    fn set_active(&self, company: CompanyRef, id: i32, active: bool) -> PortFut<'_, Value> {
        Box::pin(async move {
            let tdb = self.tenant(company).await?;
            let v = with_posts!(self, company, graph, posts, {
                if active {
                    recurrences::resume(&tdb, &posts, id, Utc::now()).await?
                } else {
                    recurrences::pause(&tdb, &posts, id, Utc::now()).await?
                }
            });
            js(&v)
        })
    }
}

impl ImportPort for SocialAdapter {
    fn plan(&self, company: CompanyRef, user_id: i32, rows: Value, mode: &str) -> PortFut<'_, Value> {
        let mode = mode_of(mode);
        Box::pin(async move {
            let (mode, rows) = (mode?, rows_of(&rows));
            let tdb = self.tenant(company).await?;
            let drafts = DraftsAdapter {
                db: &self.db,
                company,
                store: &self.store,
                env: &self.env,
                now_ms: now_ms(),
            };
            let queue = QueueAdapter {
                db: &tdb,
                now_ms: now_ms(),
            };
            let plan = with_posts!(self, company, graph, posts, {
                let ports = ImportPorts {
                    posts: &posts,
                    drafts: &drafts,
                    queue: &queue,
                };
                import::plan_structured(&tdb, &ports, user_id, &rows, mode, Utc::now()).await?
            });
            js(&plan)
        })
    }

    fn import(
        &self,
        company: CompanyRef,
        user_id: i32,
        rows: Value,
        mode: &str,
        plan_hash: &str,
    ) -> PortFut<'_, Value> {
        let mode = mode_of(mode);
        let plan_hash = plan_hash.to_owned();
        Box::pin(async move {
            let (mode, rows) = (mode?, rows_of(&rows));
            let rows = import::rows_from_structured(&rows);
            let tdb = self.tenant(company).await?;
            let drafts = DraftsAdapter {
                db: &self.db,
                company,
                store: &self.store,
                env: &self.env,
                now_ms: now_ms(),
            };
            let queue = QueueAdapter {
                db: &tdb,
                now_ms: now_ms(),
            };
            let r = with_posts!(self, company, graph, posts, {
                let ports = ImportPorts {
                    posts: &posts,
                    drafts: &drafts,
                    queue: &queue,
                };
                import::import_rows(&tdb, &ports, user_id, &rows, mode, &plan_hash, "mcp", Utc::now()).await?
            });
            js(&r)
        })
    }
}

impl MetricsPort for SocialAdapter {
    fn stats(&self, company: CompanyRef, from: DateTime<Utc>, to: DateTime<Utc>, top: i64) -> PortFut<'_, Value> {
        Box::pin(async move {
            let top = u64::try_from(top).ok();
            stats::stats(&self.db, company, &stats::StatsQuery { from, to, top }).await
        })
    }

    fn refresh_post(&self, company: CompanyRef, post_id: i32) -> PortFut<'_, RefreshReport> {
        Box::pin(async move {
            let graph = (self.infra.graph_for)(company);
            let (_, out) =
                stats::refresh_post_report(&self.runner, &self.db, company, &graph, post_id, now_ms()).await?;
            Ok(RefreshReport {
                failed: out.failed,
                throttled: out.throttled,
            })
        })
    }
}

impl DraftPublishPort for SocialAdapter {
    fn publish(
        &self,
        company: CompanyRef,
        user_id: i32,
        draft_id: i32,
        overrides: DraftOverrides,
        expect_updated_at: Option<DateTime<Utc>>,
    ) -> PortFut<'_, Value> {
        Box::pin(async move {
            let input = DraftPublish {
                scheduled_at: overrides.scheduled_at,
                expected_updated_at: expect_updated_at,
                use_queue: false,
            };
            let graph = (self.infra.graph_for)(company);
            let ctx = PostCtx {
                db: &self.db,
                company,
                env: &self.env,
                store: &self.store,
                graph: &graph,
                guard: &self.infra.guard,
                user_id,
                now_ms: now_ms(),
            };
            let post = draft_publish::publish(&ctx, draft_id, &input).await?;
            if post.scheduled_at.is_none() {
                self.runner.kick(company);
            }
            js(&post)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dong_nhap_va_che_do() {
        let rows = json!([{ "content": "A", "account_ids": [3, 4], "scheduled_at": null, "use_queue": true,
            "media_keys": ["k1"], "first_comment": null, "utm_campaign": "x" }]);
        let r = rows_of(&rows);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].account_ids, vec![3, 4]);
        assert!(r[0].use_queue && r[0].scheduled_at.is_none());
        assert_eq!(r[0].media_keys, vec!["k1".to_owned()]);
        assert!(mode_of("drafts").is_ok() && mode_of("schedule").is_ok() && mode_of("x").is_err());
    }
}
