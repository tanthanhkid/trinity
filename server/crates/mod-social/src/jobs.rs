//! Job đăng bài `social.publish` (mỗi 60 giây) và job lấy số liệu `social.metrics` (mỗi 15 phút) — M54b, chuyển từ
//! `social-publish.job.ts` + `social-posts.service.ts` (`runDue`, `claim`, `sweepStale`, `processOne`, `refreshMetricsDue`,
//! `syncPublished`).
//!
//! **Không đăng đôi.** Một bài chỉ có thể lên mạng từ một lượt đã NHẬN việc:
//! - [`Runner::claim`] nhận từng kênh bằng một câu `UPDATE … FOR UPDATE SKIP LOCKED` (đồng thời tăng `attempts`, đặt
//!   `status = 'publishing'` và hạn thuê 15 phút): hai tiến trình không bao giờ nhận cùng một dòng.
//! - Việc "đang đăng" quá hạn thuê KHÔNG được đăng lại tự động: [`Runner::sweep_stale`] chuyển sang `failed` kèm câu nhắc
//!   người dùng kiểm trên kênh rồi mới bấm Thử lại (không biết bài đã lên chưa).
//! - Mỗi kênh chạy trong một task tách riêng ([`tokio::spawn`]): scheduler hết budget và huỷ lượt thì task đang đăng vẫn chạy
//!   nốt và ghi kết quả, không để lại bài đã lên mà trạng thái là lỗi.
//! - Ghi kết quả "đã đăng" thử lại vài lần; mỗi bước DB một kết nối, nhả trước khi gọi Graph.
//!
//! **ChannelGuard.** Trước khi gọi mạng, kênh bị khoá ⇒ `failed`; đang tạm dừng tự động ⇒ trả về `queued` hẹn lại sau khi hết
//! tạm dừng (không tốn lượt thử). **Bài bị xoá trên mạng**: lấy số gặp mã `100/33` thì gắn `removed = true` vào `metrics`,
//! thôi lấy số, giao diện hiện "đã bị xoá".

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use mod_channel_guard::{BlockCode, ChannelGuard, OutboundMode, OutboundScope};
use mod_facebook::config::Env;
use mod_facebook::graph::{GraphClient, utf16_prefix};
use mod_facebook::pages::Ctx;
use serde_json::{Map, Value, json};
use trinity_db::models::{SocialAccount, SocialPost, SocialPostTarget};
use trinity_db::outbox::publish_integration_event;
use trinity_db::platform::Platform;
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, Db};
use trinity_integrations::webhooks::secret::load_secret_key;
use trinity_jobs::{JobFn, JobSpec, Scheduler, SchedulerError};
use trinity_kernel::error::AppError;

use crate::accounts::{for_publish, mark_reauth};
use crate::adapters::PostsAdapter;
use crate::config::{SOCIAL_NETWORKS, is_social_network};
use crate::first_comment::{FirstComment, first_comment_of, post_first_comment};
use crate::media::MediaStore;
use crate::posts::{acquire, refresh_status, stored_media};
use crate::provider::{PublishError, PublishErrorKind};
use crate::publish::{PostMetrics, Published, fetch_metrics, publish};
use crate::recurrences::materialize;
use crate::utm::apply_utm_to_target;

pub const PUBLISH_JOB: &str = "social.publish";
pub const METRICS_JOB: &str = "social.metrics";
pub const PUBLISH_INTERVAL: Duration = Duration::from_secs(60);
pub const PUBLISH_BUDGET: Duration = Duration::from_secs(50);
pub const METRICS_INTERVAL: Duration = Duration::from_secs(15 * 60);
pub const METRICS_BUDGET: Duration = Duration::from_secs(60);

const MINUTE_MS: i64 = 60_000;
/// Giãn cách thử lại lần 1..4 (lần thứ 5 mà lỗi thì dừng): 1, 5, 15, 60 phút (`SOCIAL_RETRY_DELAYS_MS`).
pub const RETRY_DELAYS_MS: [i64; 4] = [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 60 * MINUTE_MS];
/// Hạn thuê một lượt đăng: 15 phút (`SOCIAL_LEASE_SECONDS`).
pub const LEASE_SECONDS: f64 = 900.0;
/// Chỉ lấy số bài đăng trong 90 ngày gần nhất.
pub const METRICS_WINDOW_MS: i64 = 90 * 86_400_000;
/// Tối đa số bài mỗi lượt lấy số.
const METRICS_BATCH: i64 = 40;
/// Kênh đang tạm dừng mà không báo giờ mở lại thì hẹn lại sau 30 phút.
const DEFAULT_PAUSE_MS: i64 = 30 * MINUTE_MS;
/// Mở màn bài đăng: kiểm bài đăng trong 30 ngày, mỗi bài tối đa một lần mỗi 5 phút, tối đa 20 bài.
const SYNC_WINDOW_MS: i64 = 30 * 86_400_000;
const SYNC_RECHECK_MS: i64 = 5 * MINUTE_MS;
const SYNC_BATCH: i64 = 20;
const SYNC_BUDGET: Duration = Duration::from_secs(15);
const KICK_BUDGET: Duration = Duration::from_secs(40);
const KICK_MIN_GAP_MS: i64 = 20_000;
const FINALIZE_TRIES: usize = 3;

const STALE_NOTE: &str = "Bị gián đoạn khi đang đăng — kiểm trên kênh xem bài đã lên chưa, rồi mới bấm Thử lại.";
const CLAIM_SQL: &str = "UPDATE social_post_targets t SET status = 'publishing', attempts = t.attempts + 1, \
     claimed_at = now(), next_attempt_at = now() + make_interval(secs => $2::float8), updated_at = now() \
     WHERE t.id IN (SELECT t2.id FROM social_post_targets t2 WHERE t2.status = 'queued' AND t2.next_attempt_at <= now() \
     ORDER BY t2.next_attempt_at ASC LIMIT $1 FOR UPDATE OF t2 SKIP LOCKED) RETURNING t.id";
const SWEEP_SQL: &str = "UPDATE social_post_targets SET status = 'failed', last_error = $1, updated_at = now() \
     WHERE status = 'publishing' AND next_attempt_at <= now() RETURNING post_id";
const DUE_SQL: &str = "SELECT id FROM social_post_targets WHERE status IN ('queued', 'publishing') \
     AND next_attempt_at <= now() LIMIT 1";
const METRICS_ROWS_SQL: &str = "SELECT * FROM social_post_targets WHERE status = 'published' AND network = ANY($1) \
     AND external_post_id IS NOT NULL AND published_at >= $2 AND (metrics_at IS NULL OR metrics_at < $3) \
     ORDER BY metrics_at ASC NULLS FIRST, id ASC LIMIT $4";
const SYNC_ROWS_SQL: &str = "SELECT * FROM social_post_targets WHERE status = 'published' AND network = ANY($1) \
     AND external_post_id IS NOT NULL AND published_at >= $2 AND (metrics_at IS NULL OR metrics_at < $3) \
     ORDER BY published_at DESC LIMIT $4";
const REQUEUE_SQL: &str = "UPDATE social_post_targets SET status = 'queued', \
     attempts = CASE WHEN $4::bool THEN GREATEST(attempts - 1, 0) ELSE attempts END, \
     next_attempt_at = $2, last_error = $3, updated_at = now() WHERE id = $1";

// ───────────────────────────── hàm thuần ─────────────────────────────

/// Giãn cách thử lại sau lần đăng thứ `attempts` (đã tính lần vừa nhận); `None` = hết lượt thử.
pub fn retry_delay(attempts: i32) -> Option<i64> {
    let idx = usize::try_from(attempts.checked_sub(1)?).ok()?;
    RETRY_DELAYS_MS.get(idx).copied()
}

/// Bài mới (dưới 2 ngày) lấy số lại mỗi giờ, bài cũ hơn mỗi 6 giờ; chưa lấy lần nào thì đến hạn ngay (`metricsDue`).
pub fn metrics_due(published_at_ms: i64, metrics_at_ms: Option<i64>, now_ms: i64) -> bool {
    let Some(at) = metrics_at_ms else {
        return true;
    };
    let fresh = now_ms - published_at_ms < 2 * 86_400_000;
    now_ms - at >= (if fresh { 60 } else { 360 }) * MINUTE_MS
}

/// Số lần lấy cuối đã gắn cờ bài bị xoá trên mạng (`isRemoved`).
pub fn is_removed(metrics: Option<&Value>) -> bool {
    metrics.and_then(|m| m.get("removed")).and_then(Value::as_bool) == Some(true)
}

/// `testHooksEnabled`: `TRINITY_TEST_HOOKS=1` và `NODE_ENV` là `test` hoặc `development` (API điều khiển test bật ⇒ không lịch
/// tự động).
pub fn test_hooks_enabled(get: &impl Fn(&str) -> Option<String>) -> bool {
    get("TRINITY_TEST_HOOKS").is_some_and(|v| v.trim() == "1")
        && matches!(get("NODE_ENV").as_deref(), Some("test" | "development"))
}

fn retryable(kind: PublishErrorKind) -> bool {
    matches!(kind, PublishErrorKind::Temporary | PublishErrorKind::Rate)
}

fn ms_of(t: &Timestamp) -> i64 {
    t.0.timestamp_millis()
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn sql_err(e: &sqlx::Error) -> String {
    e.to_string()
}

fn app_err(e: &AppError) -> String {
    format!("{e:?}")
}

fn networks() -> Vec<String> {
    SOCIAL_NETWORKS.iter().map(|n| (*n).to_owned()).collect()
}

// ───────────────────────────── môi trường, kết quả ─────────────────────────────

/// Phụ thuộc của job: DB, kho tệp, env, ChannelGuard và cách dựng Graph cho từng công ty (observer riêng để cửa sổ lỗi của M45
/// phân loại đúng công ty, thường `move |c| GraphClient::new(env.clone(), Arc::new(move |o| guard.record_graph(c, o)))`).
pub struct JobDeps {
    pub db: Db,
    pub platform: Platform,
    pub env: Env,
    pub store: Arc<MediaStore>,
    pub guard: ChannelGuard,
    pub graph_for: Arc<dyn Fn(CompanyRef) -> GraphClient + Send + Sync>,
    /// Chạy ngay trước mỗi lượt đăng của công ty (ngoài việc sinh bài lặp đã có sẵn ở `tick_publish`). Lỗi chỉ ghi log, không chặn việc đăng.
    pub before_publish: Option<JobFn>,
    /// Job `social.publish` đang thuộc về Rust (tệp sở hữu)? Chỉ dùng cho [`Runner::kick`] / [`Runner::kick_if_due`];
    /// vắng ⇒ có.
    pub owns_publish: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// Kết cục một kênh sau `process_one`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Published,
    Failed,
    Retry,
}

/// Số liệu một lượt [`Runner::run_due`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunStats {
    pub published: usize,
    pub failed: usize,
    pub retry: usize,
    pub stale: usize,
}

/// Số liệu một lượt lấy số.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MetricsStats {
    pub updated: usize,
    pub failed: usize,
}

/// Bộ chạy job của MỘT tiến trình: chặn chạy chồng trong cùng tiến trình (giữa các tiến trình đã có `SKIP LOCKED`).
pub struct Runner {
    deps: JobDeps,
    running: Mutex<HashSet<i32>>,
    last_due_check: Mutex<HashMap<i32, i64>>,
}

/// Giữ chỗ "công ty này đang chạy"; nhả khi rơi.
pub struct RunGuard {
    runner: Arc<Runner>,
    company: i32,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        lock(&self.runner.running).remove(&self.company);
    }
}

impl Runner {
    pub fn new(deps: JobDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            running: Mutex::new(HashSet::new()),
            last_due_check: Mutex::new(HashMap::new()),
        })
    }

    /// Đủ `INTEGRATIONS_SECRET_KEY` để giải mã token kênh (`isSecretKeyConfigured`); thiếu ⇒ job im lặng bỏ lượt.
    fn secret_configured(&self) -> bool {
        let env = &self.deps.env;
        load_secret_key(&|k: &str| env(k)).is_ok()
    }

    fn owns_publish(&self) -> bool {
        self.deps.owns_publish.as_ref().is_none_or(|f| f())
    }

    fn try_begin(self: &Arc<Self>, company: i32) -> Option<RunGuard> {
        if !lock(&self.running).insert(company) {
            return None;
        }
        Some(RunGuard {
            runner: Arc::clone(self),
            company,
        })
    }

    // ─────────────── đăng bài ───────────────

    /// Nhận MỘT kênh đến hạn (`queued` và `next_attempt_at <= now()`), đặt `publishing` và hạn thuê. `None` = hết việc.
    pub async fn claim(&self, company: CompanyRef) -> Result<Option<i32>, String> {
        let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
        let row: Option<(i32,)> = sqlx::query_as(CLAIM_SQL)
            .bind(1_i64)
            .bind(LEASE_SECONDS)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| sql_err(&e))?;
        Ok(row.map(|r| r.0))
    }

    /// Việc "đang đăng" quá hạn thuê = tiến trình chết giữa chừng. Không biết bài đã lên chưa nên báo lỗi để người dùng kiểm
    /// rồi bấm Thử lại; KHÔNG tự đăng lại (tránh đăng đôi). Trả số kênh đã chuyển.
    pub async fn sweep_stale(&self, company: CompanyRef) -> Result<usize, String> {
        let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
        let rows: Vec<(i32,)> = sqlx::query_as(SWEEP_SQL)
            .bind(STALE_NOTE)
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| sql_err(&e))?;
        let posts: HashSet<i32> = rows.iter().map(|r| r.0).collect();
        for post_id in posts {
            refresh_status(&mut conn, post_id, now_ms())
                .await
                .map_err(|e| app_err(&e))?;
        }
        Ok(rows.len())
    }

    /// Một lượt job: dọn việc kẹt ⇒ nhận từng việc đến hạn ⇒ đăng ⇒ ghi kết quả. Ngừng nhận việc mới khi đã dùng quá nửa
    /// `budget` (video có thể mất nhiều chục giây). Không chạy chồng trong cùng tiến trình.
    pub async fn run_due(self: &Arc<Self>, company: CompanyRef, budget: Duration) -> Result<RunStats, String> {
        let mut out = RunStats::default();
        let Some(_guard) = self.try_begin(company.id()) else {
            return Ok(out);
        };
        out.stale = self.sweep_stale(company).await?;
        let started = Instant::now();
        while started.elapsed() < budget / 2 {
            let Some(id) = self.claim(company).await? else {
                break;
            };
            // Task tách riêng: huỷ lượt (hết budget) không cắt ngang một bài đang đăng giữa chừng.
            let runner = Arc::clone(self);
            let joined = tokio::spawn(async move { runner.process_one(company, id).await }).await;
            match joined {
                Ok(Ok(Outcome::Published)) => out.published += 1,
                Ok(Ok(Outcome::Failed)) => out.failed += 1,
                Ok(Ok(Outcome::Retry)) => out.retry += 1,
                Ok(Err(e)) => return Err(e),
                Err(e) => {
                    tracing::error!("Đăng kênh {id}: task dừng bất thường ({e}); việc được dọn khi hết hạn thuê");
                    out.failed += 1;
                }
            }
        }
        Ok(out)
    }

    /// Đăng ngay sau request (chạy nền, `kick`).
    pub fn kick(self: &Arc<Self>, company: CompanyRef) {
        if !self.owns_publish() {
            return;
        }
        let runner = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(e) = runner.run_due(company, KICK_BUDGET).await {
                tracing::error!("Đăng bài nền lỗi: {e}");
            }
        });
    }

    /// Nhặt bài đến hạn khi có người đang mở Trinity (`POST social/tick` mỗi phút): mỗi công ty kiểm DB tối đa một lần mỗi
    /// 20 giây; không có việc đến hạn thì không làm gì. Trả `true` khi có việc đến hạn (và đã `kick`).
    pub async fn kick_if_due(self: &Arc<Self>, company: CompanyRef, at_ms: i64) -> Result<bool, String> {
        if !self.owns_publish() {
            return Ok(false);
        }
        let id = company.id();
        if lock(&self.running).contains(&id) {
            return Ok(false);
        }
        {
            let mut last = lock(&self.last_due_check);
            if at_ms - last.get(&id).copied().unwrap_or(0) < KICK_MIN_GAP_MS {
                return Ok(false);
            }
            last.insert(id, at_ms);
        }
        let due = {
            let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
            sqlx::query_scalar::<_, i32>(DUE_SQL)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| sql_err(&e))?
        };
        if due.is_some() {
            self.kick(company);
        }
        Ok(due.is_some())
    }

    /// Giờ của kênh chờ đăng / chờ thử lại sớm nhất (`None` = không còn gì chờ): web hẹn lượt tick kế tiếp đúng giờ này.
    pub async fn next_due_at(&self, company: CompanyRef) -> Result<Option<DateTime<Utc>>, String> {
        let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
        sqlx::query_scalar(
            "SELECT min(next_attempt_at) FROM social_post_targets WHERE status IN ('queued', 'publishing')",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| sql_err(&e))
    }

    /// Ghi `failed` + phát sự kiện `social_post.failed`.
    async fn fail(&self, company: CompanyRef, t: &SocialPostTarget, message: &str) -> Result<Outcome, String> {
        let message = utf16_prefix(message, 500);
        {
            let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
            sqlx::query(
                "UPDATE social_post_targets SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1",
            )
            .bind(t.id)
            .bind(&message)
            .execute(&mut *conn)
            .await
            .map_err(|e| sql_err(&e))?;
            refresh_status(&mut conn, t.post_id, now_ms())
                .await
                .map_err(|e| app_err(&e))?;
        }
        self.event(company, t, "social_post.failed", None, Some(&message)).await;
        Ok(Outcome::Failed)
    }

    /// Webhook ra ngoài cho một lượt đăng (lỗi phát sự kiện không làm hỏng việc đăng).
    async fn event(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        kind: &str,
        url: Option<&str>,
        error: Option<&str>,
    ) {
        let payload = json!({
            "post_id": t.post_id,
            "target_id": t.id,
            "network": t.network,
            "account_id": t.account_id,
            "url": url,
            "error": error,
        });
        match acquire(&self.deps.db, company).await {
            Ok(mut conn) => {
                if let Err(e) = publish_integration_event(&mut conn, kind, &payload, t.id, None).await {
                    tracing::warn!("Sự kiện webhook đăng bài lỗi: {e}");
                }
            }
            Err(e) => tracing::warn!("Sự kiện webhook đăng bài lỗi: {e:?}"),
        }
    }

    /// Trả kênh về hàng đợi, hẹn lại lúc `at`; `refund_attempt` hoàn lượt thử vừa nhận (tạm dừng không tốn lượt).
    async fn requeue(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        at: DateTime<Utc>,
        note: &str,
        refund_attempt: bool,
    ) -> Result<Outcome, String> {
        let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
        sqlx::query(REQUEUE_SQL)
            .bind(t.id)
            .bind(at)
            .bind(utf16_prefix(note, 500))
            .bind(refund_attempt)
            .execute(&mut *conn)
            .await
            .map_err(|e| sql_err(&e))?;
        refresh_status(&mut conn, t.post_id, now_ms())
            .await
            .map_err(|e| app_err(&e))?;
        Ok(Outcome::Retry)
    }

    /// Xử lý một kênh đã nhận: kiểm bài/kênh, ChannelGuard, đăng, ghi kết quả, bình luận đầu. Lỗi DB ⇒ `Err` (kênh còn
    /// `publishing` tới khi hết hạn thuê rồi bị dọn thành `failed`, không đăng lại).
    pub async fn process_one(self: &Arc<Self>, company: CompanyRef, target_id: i32) -> Result<Outcome, String> {
        let (t, post, account) = {
            let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
            let t: Option<SocialPostTarget> = sqlx::query_as("SELECT * FROM social_post_targets WHERE id = $1")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| sql_err(&e))?;
            let Some(t) = t else {
                return Ok(Outcome::Failed);
            };
            let post: Option<SocialPost> = sqlx::query_as("SELECT * FROM social_posts WHERE id = $1")
                .bind(t.post_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| sql_err(&e))?;
            let account: Option<SocialAccount> = sqlx::query_as("SELECT * FROM social_accounts WHERE id = $1")
                .bind(t.account_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| sql_err(&e))?;
            (t, post, account)
        };
        let Some(post) = post else {
            return self.fail(company, &t, "Bài đăng không còn.").await;
        };
        let account = match account {
            Some(a) if a.status == "active" && is_social_network(&a.network) => a,
            _ => {
                return self.fail(company, &t, "Kênh cần liên kết lại (hoặc đã bị gỡ).").await;
            }
        };
        // Chống lạm dụng app dùng chung: khoá kênh ⇒ báo lỗi; tự tạm dừng (Facebook báo chặn/spam) ⇒ hẹn lại sau khi hết
        // tạm dừng.
        let guard = &self.deps.guard;
        match guard
            .block_reason(company, OutboundMode::Auto, OutboundScope::Meta)
            .await
        {
            Ok(Some(blocked)) => {
                if blocked.code == BlockCode::ChannelLocked {
                    return self.fail(company, &t, &blocked.message).await;
                }
                let until = blocked
                    .until
                    .unwrap_or_else(|| Utc::now() + chrono::Duration::milliseconds(DEFAULT_PAUSE_MS));
                return self.requeue(company, &t, until, &blocked.message, true).await;
            }
            Ok(None) => {}
            Err(e) => {
                // Không kiểm được trạng thái kênh: chưa gửi gì, hẹn lại ngắn thay vì đăng khi chưa chắc được phép.
                tracing::warn!("Kiểm ChannelGuard trước khi đăng lỗi: {}", app_err(&e));
                let at = Utc::now() + chrono::Duration::milliseconds(MINUTE_MS);
                let note = "Không kiểm được trạng thái kênh gửi — sẽ thử lại sau 1 phút.";
                return self.requeue(company, &t, at, note, true).await;
            }
        }
        match self.try_publish(company, &t, &post, &account).await {
            Ok((published, options)) => {
                self.finalize_published(company, &t, &published).await?;
                let url = Some(published.url.as_str());
                self.event(company, &t, "social_post.published", url, None).await;
                self.first_comment(company, &t, &account, &published, &options).await;
                Ok(Outcome::Published)
            }
            Err(e) => self.on_publish_error(company, &t, &account, e).await,
        }
    }

    /// Giải mã token, gắn UTM ngay trước khi gọi mạng (bài lưu trong CRM vẫn là bản sạch), rồi đăng. KHÔNG giữ kết nối DB.
    async fn try_publish(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        post: &SocialPost,
        account: &SocialAccount,
    ) -> Result<(Published, Map<String, Value>), PublishError> {
        let acc = for_publish(&self.deps.env, account).map_err(|_| PublishError {
            kind: PublishErrorKind::Temporary,
            message: "Lỗi máy chủ khi đăng (không giải mã được khoá của kênh).".to_owned(),
        })?;
        let media = stored_media(&post.media.0);
        let options: Map<String, Value> = t.options.0.as_object().cloned().unwrap_or_default();
        let base = t.caption.as_deref().unwrap_or(&post.content);
        let (text, sent_options) = apply_utm_to_target(&account.network, base, &options);
        let graph = (self.deps.graph_for)(company);
        let published = publish(&graph, &self.deps.store, &acc, &text, &media, &sent_options).await?;
        Ok((published, sent_options))
    }

    /// Ghi "đã đăng". Bài ĐÃ lên mạng nên thử lại vài lần trước khi bỏ cuộc (bỏ cuộc ⇒ kênh còn `publishing`, tới hạn thuê
    /// bị dọn thành `failed` với câu nhắc kiểm trên kênh).
    async fn finalize_published(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        published: &Published,
    ) -> Result<(), String> {
        let mut last = String::new();
        for attempt in 0..FINALIZE_TRIES {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            match self.write_published(company, t, published).await {
                Ok(()) => return Ok(()),
                Err(e) => last = e,
            }
        }
        tracing::error!(
            "Bài của kênh {} đã lên mạng nhưng không ghi được kết quả sau {FINALIZE_TRIES} lần: {last}",
            t.id
        );
        Err(last)
    }

    async fn write_published(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        published: &Published,
    ) -> Result<(), String> {
        let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
        sqlx::query(
            "UPDATE social_post_targets SET status = 'published', external_post_id = $2, url = $3, \
             published_at = now(), last_error = NULL, updated_at = now() WHERE id = $1",
        )
        .bind(t.id)
        .bind(utf16_prefix(&published.external_post_id, 120))
        .bind(&published.url)
        .execute(&mut *conn)
        .await
        .map_err(|e| sql_err(&e))?;
        refresh_status(&mut conn, t.post_id, now_ms())
            .await
            .map_err(|e| app_err(&e))
    }

    /// Bình luận đầu tiên (tuỳ chọn): lỗi KHÔNG làm hỏng bài đã lên, chỉ ghi lên kênh để người dùng thấy bình luận chưa lên.
    async fn first_comment(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        account: &SocialAccount,
        published: &Published,
        options: &Map<String, Value>,
    ) {
        if account.network != "facebook" {
            return;
        }
        let Some(comment) = first_comment_of(options) else {
            return;
        };
        let graph = (self.deps.graph_for)(company);
        let ctx = Ctx {
            db: &self.deps.db,
            env: &self.deps.env,
            graph: &graph,
            platform: &self.deps.platform,
            company,
        };
        let posted = post_first_comment(&ctx, &account.external_id, &published.external_post_id, &comment).await;
        let note = match posted {
            Ok(FirstComment::Posted) => None,
            Ok(FirstComment::NoPage) => Some(format!(
                "Fanpage {} không còn kết nối ở mục Fanpage Facebook",
                account.name
            )),
            Err(e) => Some(e),
        };
        let Some(note) = note else {
            return;
        };
        tracing::warn!("Bài {}: bình luận đầu tiên — {note}", t.post_id);
        let message = utf16_prefix(&format!("Bài đã lên; chưa đăng được bình luận đầu tiên: {note}"), 500);
        if let Ok(mut conn) = acquire(&self.deps.db, company).await {
            let r = sqlx::query("UPDATE social_post_targets SET last_error = $2, updated_at = now() WHERE id = $1")
                .bind(t.id)
                .bind(message)
                .execute(&mut *conn)
                .await;
            if let Err(e) = r {
                tracing::warn!("Ghi lỗi bình luận đầu tiên của kênh {} thất bại: {e}", t.id);
            }
        }
    }

    /// Phân loại lỗi đăng: token ⇒ kênh cần liên kết lại (không thử lại); tạm thời/giới hạn tần suất ⇒ thử lại có giãn cách;
    /// còn lại ⇒ lỗi luôn (sửa bài/quyền rồi bấm Thử lại).
    async fn on_publish_error(
        &self,
        company: CompanyRef,
        t: &SocialPostTarget,
        account: &SocialAccount,
        e: PublishError,
    ) -> Result<Outcome, String> {
        tracing::warn!(
            "Đăng kênh {} ({}) lỗi {:?}: {}",
            t.id,
            account.network,
            e.kind,
            e.message
        );
        if e.kind == PublishErrorKind::Token {
            {
                let mut conn = acquire(&self.deps.db, company).await.map_err(|x| app_err(&x))?;
                mark_reauth(&mut conn, account.id, &e.message)
                    .await
                    .map_err(|x| app_err(&x))?;
            }
            return self.fail(company, t, &e.message).await;
        }
        if retryable(e.kind)
            && let Some(delay) = retry_delay(t.attempts)
        {
            let at = Utc::now() + chrono::Duration::milliseconds(delay);
            let minutes = (delay + MINUTE_MS / 2) / MINUTE_MS;
            let note = format!("{} Sẽ tự thử lại sau {minutes} phút.", e.message);
            return self.requeue(company, t, at, &note, false).await;
        }
        let message = if retryable(e.kind) {
            format!("{} Bấm Thử lại để đăng lại.", e.message)
        } else {
            e.message
        };
        self.fail(company, t, &message).await
    }

    // ─────────────── số liệu ───────────────

    async fn stamp(&self, company: CompanyRef, target_id: i32) {
        let r: Result<(), String> = async {
            let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
            sqlx::query("UPDATE social_post_targets SET metrics_at = now(), updated_at = now() WHERE id = $1")
                .bind(target_id)
                .execute(&mut *conn)
                .await
                .map(drop)
                .map_err(|e| sql_err(&e))
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Đóng mốc lấy số của kênh {target_id} lỗi: {e}");
        }
    }

    async fn store_metrics(&self, company: CompanyRef, target_id: i32, metrics: &Value) {
        let r: Result<(), String> = async {
            let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
            sqlx::query(
                "UPDATE social_post_targets SET metrics = $2::text::jsonb, metrics_at = now(), updated_at = now() \
                 WHERE id = $1",
            )
            .bind(target_id)
            .bind(metrics.to_string())
            .execute(&mut *conn)
            .await
            .map(drop)
            .map_err(|e| sql_err(&e))
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("Ghi số liệu của kênh {target_id} lỗi: {e}");
        }
    }

    /// Lấy số một kênh đã đăng (`fetchTargetMetrics`); luôn đóng mốc `metrics_at` (cả khi lỗi) để lượt sau không dồn vào cùng
    /// một bài hỏng. `true` = đã có số mới. Mỗi bước DB một kết nối, nhả trước khi gọi Graph.
    pub async fn fetch_target_metrics(&self, company: CompanyRef, graph: &GraphClient, t: &SocialPostTarget) -> bool {
        let account: Result<Option<SocialAccount>, String> = async {
            let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
            sqlx::query_as("SELECT * FROM social_accounts WHERE id = $1")
                .bind(t.account_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| sql_err(&e))
        }
        .await;
        let usable = match account {
            Ok(Some(a)) if a.status == "active" && is_social_network(&a.network) => Some(a),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("Đọc kênh để lấy số lỗi: {e}");
                return false;
            }
        };
        let (Some(account), Some(external)) = (usable, t.external_post_id.as_deref()) else {
            self.stamp(company, t.id).await;
            return false;
        };
        let acc = match for_publish(&self.deps.env, &account) {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!("Lấy số kênh {}: không giải mã được khoá ({})", t.id, app_err(&e));
                self.stamp(company, t.id).await;
                return false;
            }
        };
        match fetch_metrics(graph, &acc, external).await {
            Ok(m) => {
                let value = serde_json::to_value(&m).unwrap_or(Value::Null);
                self.store_metrics(company, t.id, &value).await;
                true
            }
            Err(e) if e.kind == PublishErrorKind::Gone => {
                // Bài đã bị xoá trên kênh: giữ số lần lấy cuối (nếu có), gắn cờ để thôi lấy và giao diện hiện "đã bị xoá".
                let empty = PostMetrics {
                    views: None,
                    reactions: None,
                    comments: None,
                    shares: None,
                };
                let mut marked = t
                    .metrics
                    .clone()
                    .map(|m| m.0)
                    .filter(Value::is_object)
                    .unwrap_or_else(|| serde_json::to_value(empty).unwrap_or(Value::Null));
                if let Some(o) = marked.as_object_mut() {
                    o.insert("removed".to_owned(), Value::Bool(true));
                }
                self.store_metrics(company, t.id, &marked).await;
                false
            }
            Err(e) => {
                // Không đánh dấu kênh cần liên kết lại ở đây: lỗi lấy số không được làm hỏng việc đăng bài.
                tracing::warn!("Lấy số kênh {} ({}) lỗi: {}", t.id, account.network, e.message);
                self.stamp(company, t.id).await;
                false
            }
        }
    }

    async fn published_rows(
        &self,
        company: CompanyRef,
        sql: &'static str,
        since_ms: i64,
        not_after_ms: i64,
        limit: i64,
    ) -> Result<Vec<SocialPostTarget>, String> {
        let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
        sqlx::query_as(sql)
            .bind(networks())
            .bind(DateTime::<Utc>::from_timestamp_millis(since_ms))
            .bind(DateTime::<Utc>::from_timestamp_millis(not_after_ms))
            .bind(limit)
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| sql_err(&e))
    }

    /// Lấy số của các bài đến hạn (job định kỳ): lỗi một bài không chặn bài khác.
    pub async fn refresh_metrics_due(
        &self,
        company: CompanyRef,
        budget: Duration,
        at_ms: i64,
    ) -> Result<MetricsStats, String> {
        let started = Instant::now();
        let (since, before) = (at_ms - METRICS_WINDOW_MS, at_ms - 60 * MINUTE_MS);
        let rows = self
            .published_rows(company, METRICS_ROWS_SQL, since, before, METRICS_BATCH)
            .await?;
        let graph = (self.deps.graph_for)(company);
        let mut out = MetricsStats::default();
        for t in &rows {
            if started.elapsed() > budget {
                break;
            }
            let Some(published_at) = t.published_at.as_ref() else {
                continue;
            };
            let due = metrics_due(ms_of(published_at), t.metrics_at.as_ref().map(ms_of), at_ms);
            if !due || is_removed(t.metrics.as_ref().map(|m| &m.0)) {
                continue;
            }
            if self.fetch_target_metrics(company, &graph, t).await {
                out.updated += 1;
            } else {
                out.failed += 1;
            }
        }
        Ok(out)
    }

    /// Mở màn bài đăng: kiểm nhanh bài đăng trong 30 ngày còn trên mạng không (lấy số luôn), để bài bị xoá thẳng trên mạng
    /// hiện "đã xoá" mà không chờ lượt lấy số định kỳ. Mỗi bài tối đa một lần mỗi 5 phút, tối đa 20 bài, ngân sách 15 giây.
    /// Trả `(đã kiểm, đã xoá)`.
    pub async fn sync_published(&self, company: CompanyRef, at_ms: i64) -> Result<(usize, usize), String> {
        let (since, before) = (at_ms - SYNC_WINDOW_MS, at_ms - SYNC_RECHECK_MS);
        let rows = self
            .published_rows(company, SYNC_ROWS_SQL, since, before, SYNC_BATCH)
            .await?;
        let graph = (self.deps.graph_for)(company);
        let started = Instant::now();
        let (mut checked, mut removed) = (0_usize, 0_usize);
        for t in &rows {
            if is_removed(t.metrics.as_ref().map(|m| &m.0)) || started.elapsed() > SYNC_BUDGET {
                continue;
            }
            checked += 1;
            self.fetch_target_metrics(company, &graph, t).await;
            let after: Option<Option<Value>> = {
                let mut conn = acquire(&self.deps.db, company).await.map_err(|e| app_err(&e))?;
                sqlx::query_scalar("SELECT metrics FROM social_post_targets WHERE id = $1")
                    .bind(t.id)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|e| sql_err(&e))?
            };
            if is_removed(after.flatten().as_ref()) {
                removed += 1;
            }
        }
        Ok((checked, removed))
    }

    // ─────────────── lịch ───────────────

    /// `recurrences::materialize` với cổng bài đăng thật ([`PostsAdapter`]).
    pub async fn materialize_recurrences(&self, company: CompanyRef) -> Result<(), String> {
        let tenant = self.deps.db.tenant(company).await.map_err(|e| e.to_string())?;
        let graph = (self.deps.graph_for)(company);
        let posts = PostsAdapter {
            db: &self.deps.db,
            company,
            env: &self.deps.env,
            store: &self.deps.store,
            graph: &graph,
            guard: &self.deps.guard,
            now_ms: now_ms(),
        };
        materialize(&tenant, &posts, Utc::now())
            .await
            .map(drop)
            .map_err(|e| app_err(&e))
    }

    async fn tick_publish(self: &Arc<Self>, company: CompanyRef) -> Result<(), String> {
        if !self.secret_configured() {
            return Ok(());
        }
        // Sinh bài kế tiếp của lịch lặp (M55b) trước mỗi lượt đăng; lỗi chỉ ghi log, không chặn việc đăng.
        if let Err(e) = self.materialize_recurrences(company).await {
            tracing::error!("Sinh bài lặp lỗi: {e}");
        }
        if let Some(before) = &self.deps.before_publish
            && let Err(e) = before(company).await
        {
            tracing::error!("Việc chuẩn bị trước lượt đăng bài lỗi: {e}");
        }
        self.run_due(company, PUBLISH_BUDGET).await.map(drop)
    }

    async fn tick_metrics(self: &Arc<Self>, company: CompanyRef) -> Result<(), String> {
        if !self.secret_configured() {
            return Ok(());
        }
        self.refresh_metrics_due(company, METRICS_BUDGET, now_ms())
            .await
            .map(drop)
    }
}

/// Khai báo job đăng bài (không đăng ký).
pub fn publish_spec(runner: Arc<Runner>) -> Result<JobSpec, SchedulerError> {
    JobSpec::new(PUBLISH_JOB, PUBLISH_INTERVAL, PUBLISH_BUDGET, move |company| {
        let runner = Arc::clone(&runner);
        async move { runner.tick_publish(company).await }
    })
}

/// Khai báo job lấy số liệu (không đăng ký).
pub fn metrics_spec(runner: Arc<Runner>) -> Result<JobSpec, SchedulerError> {
    JobSpec::new(METRICS_JOB, METRICS_INTERVAL, METRICS_BUDGET, move |company| {
        let runner = Arc::clone(&runner);
        async move { runner.tick_metrics(company).await }
    })
}

/// Đăng ký hai job với scheduler K20 (chủ job do tệp sở hữu quyết định). API điều khiển test bật ⇒ không đăng ký (C18). Trả
/// tên job đã đăng ký.
pub fn register(
    scheduler: &Scheduler,
    runner: &Arc<Runner>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<Vec<&'static str>, SchedulerError> {
    if test_hooks_enabled(&get) {
        return Ok(Vec::new());
    }
    scheduler.register(publish_spec(Arc::clone(runner))?);
    scheduler.register(metrics_spec(Arc::clone(runner))?);
    Ok(vec![PUBLISH_JOB, METRICS_JOB])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn giai_doan_thu_lai() {
        assert_eq!(retry_delay(1), Some(60_000));
        assert_eq!(retry_delay(2), Some(300_000));
        assert_eq!(retry_delay(3), Some(900_000));
        assert_eq!(retry_delay(4), Some(3_600_000));
        // Lần thứ 5 lỗi ⇒ hết lượt; giá trị lạ không panic.
        assert_eq!(retry_delay(5), None);
        assert_eq!(retry_delay(0), None);
        assert_eq!(retry_delay(i32::MIN), None);
    }

    #[test]
    fn den_han_lay_so() {
        let now = 1_800_000_000_000;
        let min = MINUTE_MS;
        // Chưa lấy lần nào ⇒ đến hạn ngay.
        assert!(metrics_due(now - 10 * min, None, now));
        // Bài mới (< 2 ngày): mỗi giờ.
        let fresh = now - 86_400_000;
        assert!(!metrics_due(fresh, Some(now - 59 * min), now));
        assert!(metrics_due(fresh, Some(now - 60 * min), now));
        // Bài cũ: mỗi 6 giờ.
        let old = now - 3 * 86_400_000;
        assert!(!metrics_due(old, Some(now - 359 * min), now));
        assert!(metrics_due(old, Some(now - 360 * min), now));
    }

    #[test]
    fn co_xoa_tren_mang() {
        assert!(is_removed(Some(&json!({"views": null, "removed": true}))));
        assert!(!is_removed(Some(&json!({"removed": false}))));
        assert!(!is_removed(Some(&json!({"removed": "true"}))));
        assert!(!is_removed(Some(&Value::Null)));
        assert!(!is_removed(None));
    }

    #[test]
    fn phan_loai_thu_lai() {
        assert!(retryable(PublishErrorKind::Temporary));
        assert!(retryable(PublishErrorKind::Rate));
        for k in [
            PublishErrorKind::Token,
            PublishErrorKind::Permission,
            PublishErrorKind::Invalid,
            PublishErrorKind::Gone,
        ] {
            assert!(!retryable(k));
        }
    }

    #[test]
    fn api_dieu_khien_test_tat_lich() {
        assert!(test_hooks_enabled(&env(&[
            ("TRINITY_TEST_HOOKS", "1"),
            ("NODE_ENV", "test")
        ])));
        let prod = env(&[("TRINITY_TEST_HOOKS", "1"), ("NODE_ENV", "production")]);
        assert!(!test_hooks_enabled(&prod));
        assert!(!test_hooks_enabled(&env(&[("NODE_ENV", "test")])));
    }

    #[test]
    fn ten_va_chu_ky() {
        assert_eq!((PUBLISH_JOB, PUBLISH_INTERVAL.as_secs()), ("social.publish", 60));
        assert_eq!((METRICS_JOB, METRICS_INTERVAL.as_secs()), ("social.metrics", 900));
        assert!(PUBLISH_BUDGET < PUBLISH_INTERVAL);
    }
}
